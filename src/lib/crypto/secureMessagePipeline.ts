import { supabase } from '@/integrations/supabase/client';
import { createEpochBoundEnvelope, assertEnvelopeEpochValid, type EpochBoundEnvelope } from './epochEnvelope';
import { issueSenderCertificate, fetchSenderCertificate, type SenderCertificate } from './senderCertificate';
import { assertNotReplayPersistent, computeReplayKey } from './replayGuard';
import { getOrCreateCurrentDeviceId } from './deviceList';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { base64ToBuffer } from './utils';

export interface SecurePipelineEnvelope {
  fs_secure_pipeline: 1;
  body: string;
  meta: EpochBoundEnvelope<Record<string, unknown>>;
}

export function isSecurePipelineEnvelope(input: string): boolean {
  try {
    const parsed = JSON.parse(input);
    return parsed?.fs_secure_pipeline === 1 && typeof parsed.body === 'string' && !!parsed.meta;
  } catch {
    return false;
  }
}

export function unwrapSecurePipelineEnvelope(input: string): SecurePipelineEnvelope | null {
  try {
    const parsed = JSON.parse(input) as SecurePipelineEnvelope;
    if (parsed?.fs_secure_pipeline !== 1 || typeof parsed.body !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// H4 (audit) — REMOVED server-side "sealed sender" telemetry.
// The previous implementation wrote the sender's conversation_id and identity
// fingerprint (sender_hint_hash) to `sealed_sender_events`, which directly
// defeats the stated anonymity property: it hands the server exactly the
// sender→conversation linkage that sealed sender is supposed to hide. No
// sender-identifying metadata is published anymore.

export async function wrapOutboundSecureMessage(params: {
  userId: string;
  fingerprint: string;
  encryptedBody: string;
  conversationId: string;
  localId: string;
}): Promise<string> {
  const cert = await issueSenderCertificate(params.userId, params.fingerprint).catch(() => null);
  const meta = createEpochBoundEnvelope(
    params.userId,
    {
      conversationId: params.conversationId,
      localId: params.localId,
      deviceId: getOrCreateCurrentDeviceId(),
      createdAt: Date.now(),
    },
    cert,
  );

  const envelope: SecurePipelineEnvelope = {
    fs_secure_pipeline: 1,
    body: params.encryptedBody,
    meta,
  };

  return JSON.stringify(envelope);
}

export async function validateInboundSecureEnvelope(params: {
  localUserId: string;
  messageId?: string | null;
  body: string;
}): Promise<{ body: string; meta: EpochBoundEnvelope<Record<string, unknown>> | null }> {
  const wrapped = unwrapSecurePipelineEnvelope(params.body);
  if (!wrapped) return { body: params.body, meta: null };

  assertEnvelopeEpochValid(params.localUserId, wrapped.meta);

  const replayKey = computeReplayKey([
    params.messageId,
    wrapped.meta.identityEpoch,
    wrapped.meta.payload?.localId as string | undefined,
    wrapped.meta.payload?.createdAt as number | undefined,
  ]);
  await assertNotReplayPersistent(replayKey);

  const certOk = await validateSenderCertificateShape(wrapped.meta.senderCertificate);
  if (!certOk) {
    throw new Error('INVALID_SENDER_CERTIFICATE');
  }

  return { body: wrapped.body, meta: wrapped.meta };
}

export async function validateSenderCertificateShape(cert: SenderCertificate | null | undefined): Promise<boolean> {
  if (!cert?.payload || !cert.signature) return false;
  if (cert.payload.expiresAt <= Date.now()) return false;

  // H3 (audit) — the Ed25519 signature over the certificate payload is the
  // REAL authentication and is ALWAYS verified. Previously the function
  // returned `true` (accept) whenever the server returned no "latest"
  // certificate, or the fetch failed — letting an attacker (or a flaky
  // network) skip verification entirely. Verification is now mandatory; the
  // freshness/epoch comparison against `latest` is only an ADDITIONAL check.
  let signingKey: string | undefined;
  try {
    const { data } = await supabase
      .from('user_public_keys')
      .select('signing_key')
      .eq('user_id', cert.payload.userId)
      .eq('is_active', true)
      .maybeSingle();
    signingKey = (data as any)?.signing_key;
  } catch {
    return false;
  }
  if (!signingKey) return false;

  let signatureValid = false;
  try {
    const publicKey = await hardCrypto.importKey(
      'raw',
      base64ToBuffer(signingKey),
      'Ed25519' as any,
      true,
      ['verify'],
    );
    const payloadBytes = new hardGlobals.TextEncoder().encode(JSON.stringify(cert.payload));
    signatureValid = await hardCrypto.verify(
      'Ed25519' as any,
      publicKey,
      base64ToBuffer(cert.signature),
      payloadBytes,
    );
  } catch {
    return false;
  }
  if (!signatureValid) return false;

  // Additional freshness check: if a newer certificate exists server-side it
  // MUST match (defends against stale/replayed certificates). Absence of a
  // server copy is not, by itself, grounds to reject a validly-signed cert.
  const latest = await fetchSenderCertificate(cert.payload.userId, cert.payload.deviceId).catch(() => null);
  if (latest && (latest.signature !== cert.signature || latest.payload.identityEpoch !== cert.payload.identityEpoch)) {
    return false;
  }

  return true;
}
