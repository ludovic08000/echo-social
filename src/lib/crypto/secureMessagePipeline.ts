import { supabase } from '@/integrations/supabase/client';
import { createEpochBoundEnvelope, assertEnvelopeEpochValid, type EpochBoundEnvelope } from './epochEnvelope';
import { issueSenderCertificate, fetchSenderCertificate, type SenderCertificate } from './senderCertificate';
import { assertNotReplay, computeReplayKey } from './replayGuard';
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

function publishSealedSenderTelemetry(params: {
  conversationId: string;
  meta: EpochBoundEnvelope<Record<string, unknown>>;
}): void {
  void supabase.from('sealed_sender_events' as any).insert({
    conversation_id: params.conversationId,
    anonymous_sender_tag: params.meta.sealedSender?.anonymousSenderTag || 'none',
    sender_hint_hash: params.meta.senderCertificate?.payload?.fingerprint || null,
    recipient_user_id: null,
  }).catch(() => {});
}

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

  publishSealedSenderTelemetry({ conversationId: params.conversationId, meta });

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
  assertNotReplay(replayKey);

  const certOk = await validateSenderCertificateShape(wrapped.meta.senderCertificate);
  if (!certOk) {
    throw new Error('INVALID_SENDER_CERTIFICATE');
  }

  return { body: wrapped.body, meta: wrapped.meta };
}

export async function validateSenderCertificateShape(cert: SenderCertificate | null | undefined): Promise<boolean> {
  if (!cert?.payload || !cert.signature) return false;
  if (cert.payload.expiresAt <= Date.now()) return false;

  const latest = await fetchSenderCertificate(cert.payload.userId, cert.payload.deviceId).catch(() => null);
  if (!latest) return true;

  if (latest.signature !== cert.signature || latest.payload.identityEpoch !== cert.payload.identityEpoch) {
    return false;
  }

  try {
    const { data } = await supabase
      .from('user_public_keys')
      .select('signing_key')
      .eq('user_id', cert.payload.userId)
      .eq('is_active', true)
      .maybeSingle();

    const signingKey = (data as any)?.signing_key;
    if (!signingKey) return false;

    const publicKey = await hardCrypto.importKey(
      'raw',
      base64ToBuffer(signingKey),
      'Ed25519' as any,
      true,
      ['verify'],
    );

    const payloadBytes = new hardGlobals.TextEncoder().encode(JSON.stringify(cert.payload));

    return await hardCrypto.verify(
      'Ed25519' as any,
      publicKey,
      base64ToBuffer(cert.signature),
      payloadBytes,
    );
  } catch {
    return false;
  }
}
