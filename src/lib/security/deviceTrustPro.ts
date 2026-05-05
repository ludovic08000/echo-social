import { bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { exportPublicKeyBundle, type IdentityKeyPair } from '@/lib/crypto/keyManager';

const TRUST_QR_VERSION = 1;
const TRUST_DOMAIN = 'forsure-device-trust-v1';

export interface SignedDeviceTrustPayload {
  v: number;
  domain: string;
  userId: string;
  deviceId: string;
  deviceLabel?: string | null;
  identityFingerprint: string;
  identityKey: string;
  signingKey: string;
  createdAt: string;
  expiresAt: string;
  nonce: string;
  signature: string;
}

export interface DeviceTrustVerificationResult {
  ok: boolean;
  reason?: string;
  payload?: SignedDeviceTrustPayload;
}

function encodeCanonical(value: unknown): Uint8Array {
  return new hardGlobals.TextEncoder().encode(JSON.stringify(value));
}

function canonicalPayloadForSignature(payload: Omit<SignedDeviceTrustPayload, 'signature'>) {
  return {
    v: payload.v,
    domain: payload.domain,
    userId: payload.userId,
    deviceId: payload.deviceId,
    deviceLabel: payload.deviceLabel ?? null,
    identityFingerprint: payload.identityFingerprint,
    identityKey: payload.identityKey,
    signingKey: payload.signingKey,
    createdAt: payload.createdAt,
    expiresAt: payload.expiresAt,
    nonce: payload.nonce,
  };
}

async function importEd25519Public(signingKeyB64: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(signingKeyB64);
  return hardCrypto.importKey('raw', raw, { name: 'Ed25519' } as any, false, ['verify']);
}

export async function createSignedDeviceTrustQR(input: {
  userId: string;
  deviceId: string;
  deviceLabel?: string | null;
  keys: IdentityKeyPair;
  ttlMs?: number;
}): Promise<string> {
  const bundle = await exportPublicKeyBundle(input.keys);
  const now = Date.now();
  const unsigned = canonicalPayloadForSignature({
    v: TRUST_QR_VERSION,
    domain: TRUST_DOMAIN,
    userId: input.userId,
    deviceId: input.deviceId,
    deviceLabel: input.deviceLabel ?? null,
    identityFingerprint: bundle.fingerprint,
    identityKey: bundle.identityKey,
    signingKey: bundle.signingKey,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (input.ttlMs ?? 5 * 60_000)).toISOString(),
    nonce: bufferToBase64(hardCrypto.getRandomValues(new Uint8Array(16)).buffer),
  });

  const signature = await hardCrypto.sign(
    'Ed25519' as any,
    input.keys.signingPrivateKey,
    encodeCanonical(unsigned),
  );

  const payload: SignedDeviceTrustPayload = {
    ...unsigned,
    signature: bufferToBase64(signature),
  };

  return bufferToBase64(encodeCanonical(payload).buffer as ArrayBuffer);
}

export async function verifySignedDeviceTrustQR(qrData: string): Promise<DeviceTrustVerificationResult> {
  try {
    const json = new hardGlobals.TextDecoder().decode(base64ToBuffer(qrData));
    const payload = JSON.parse(json) as SignedDeviceTrustPayload;
    if (payload.domain !== TRUST_DOMAIN || payload.v !== TRUST_QR_VERSION) {
      return { ok: false, reason: 'unsupported_trust_payload' };
    }
    if (Date.now() > new Date(payload.expiresAt).getTime()) {
      return { ok: false, reason: 'expired_trust_payload', payload };
    }
    if (!payload.userId || !payload.deviceId || !payload.signingKey || !payload.signature) {
      return { ok: false, reason: 'malformed_trust_payload' };
    }

    const unsigned = canonicalPayloadForSignature(payload);
    const pub = await importEd25519Public(payload.signingKey);
    const ok = await hardCrypto.verify(
      'Ed25519' as any,
      pub,
      base64ToBuffer(payload.signature),
      encodeCanonical(unsigned),
    );
    return ok ? { ok: true, payload } : { ok: false, reason: 'bad_signature', payload };
  } catch {
    return { ok: false, reason: 'parse_error' };
  }
}

export function formatTrustFingerprint(fingerprint: string): string {
  return fingerprint.replace(/\s+/g, '').toUpperCase().match(/.{1,4}/g)?.join(' ') ?? fingerprint;
}

export function buildManualVerificationText(payload: SignedDeviceTrustPayload): string {
  return [
    `Compte: ${payload.userId}`,
    `Appareil: ${payload.deviceLabel || payload.deviceId}`,
    `Fingerprint: ${formatTrustFingerprint(payload.identityFingerprint)}`,
  ].join('\n');
}
