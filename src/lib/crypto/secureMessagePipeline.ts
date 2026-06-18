import { supabase } from '@/integrations/supabase/client';
import { createEpochBoundEnvelope, assertEnvelopeEpochValid, type EpochBoundEnvelope } from './epochEnvelope';
import { issueSenderCertificate, fetchSenderCertificate, type SenderCertificate } from './senderCertificate';
import { assertNotReplay, computeReplayKey } from './replayGuard';
import { getOrCreateCurrentDeviceId } from './deviceList';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { base64ToBuffer } from './utils';

const CERT_VALIDATION_TTL_MS = 5 * 60 * 1000;
const SIGNING_KEY_TTL_MS = 5 * 60 * 1000;
const MAX_VALIDATION_CACHE_ENTRIES = 500;
const MAX_SIGNING_KEY_CACHE_ENTRIES = 200;

export interface SecurePipelineEnvelope {
  fs_secure_pipeline: 1;
  body: string;
  meta: EpochBoundEnvelope<Record<string, unknown>>;
}

const certValidationCache = new Map<string, { valid: boolean; expiresAt: number }>();
const signingKeyCache = new Map<string, { key: string | null; expiresAt: number; promise?: Promise<string | null> }>();

function rememberValidation(key: string, valid: boolean, expiresAt: number): boolean {
  certValidationCache.set(key, { valid, expiresAt });
  while (certValidationCache.size > MAX_VALIDATION_CACHE_ENTRIES) {
    const oldest = certValidationCache.keys().next().value;
    if (!oldest) break;
    certValidationCache.delete(oldest);
  }
  return valid;
}

async function getSigningKeyCached(userId: string): Promise<string | null> {
  const now = Date.now();
  const cached = signingKeyCache.get(userId);
  if (cached && cached.expiresAt > now) {
    if (cached.promise) return cached.promise;
    return cached.key;
  }

  const promise = supabase
    .from('user_public_keys')
    .select('signing_key')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle()
    .then(({ data }) => ((data as any)?.signing_key as string | null | undefined) ?? null)
    .then((key) => {
      signingKeyCache.set(userId, { key, expiresAt: Date.now() + SIGNING_KEY_TTL_MS });
      while (signingKeyCache.size > MAX_SIGNING_KEY_CACHE_ENTRIES) {
        const oldest = signingKeyCache.keys().next().value;
        if (!oldest) break;
        signingKeyCache.delete(oldest);
      }
      return key;
    })
    .catch(() => {
      signingKeyCache.delete(userId);
      return null;
    });

  signingKeyCache.set(userId, { key: null, expiresAt: now + SIGNING_KEY_TTL_MS, promise });
  return promise;
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

  try {
    await supabase.from('sealed_sender_events' as any).insert({
      conversation_id: params.conversationId,
      anonymous_sender_tag: meta.sealedSender?.anonymousSenderTag || 'none',
      sender_hint_hash: meta.senderCertificate?.payload?.fingerprint || null,
      recipient_user_id: null,
    });
  } catch {}

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

  const cacheKey = [
    cert.payload.userId,
    cert.payload.deviceId,
    cert.payload.identityEpoch,
    cert.payload.fingerprint,
    cert.signature,
  ].join(':');
  const cached = certValidationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.valid;
  certValidationCache.delete(cacheKey);

  const cacheUntil = Math.min(cert.payload.expiresAt, Date.now() + CERT_VALIDATION_TTL_MS);

  const latest = await fetchSenderCertificate(cert.payload.userId, cert.payload.deviceId).catch(() => null);
  if (!latest) return true;

  if (latest.signature !== cert.signature || latest.payload.identityEpoch !== cert.payload.identityEpoch) {
    return rememberValidation(cacheKey, false, cacheUntil);
  }

  try {
    const signingKey = await getSigningKeyCached(cert.payload.userId);
    if (!signingKey) return false;

    const publicKey = await hardCrypto.importKey(
      'raw',
      base64ToBuffer(signingKey),
      'Ed25519' as any,
      true,
      ['verify'],
    );

    const payloadBytes = new hardGlobals.TextEncoder().encode(JSON.stringify(cert.payload));

    const verified = await hardCrypto.verify(
      'Ed25519' as any,
      publicKey,
      base64ToBuffer(cert.signature),
      payloadBytes,
    );
    return rememberValidation(cacheKey, verified, cacheUntil);
  } catch {
    return false;
  }
}
