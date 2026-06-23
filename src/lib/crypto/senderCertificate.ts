import { supabase } from '@/integrations/supabase/client';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { bufferToBase64, base64ToBuffer } from './utils';
import { loadIdentityKeys } from './keyManager';
import { getOrCreateCurrentDeviceId } from './deviceList';
import { getLocalSecurityEpoch } from './securityEpoch';

const CERT_TTL_MS = 24 * 60 * 60 * 1000;
const CERT_REFRESH_SKEW_MS = 5 * 60 * 1000;
const certCache = new Map<string, SenderCertificate>();

export interface SenderCertificatePayload {
  version: 1;
  userId: string;
  deviceId: string;
  fingerprint: string;
  identityEpoch: number;
  issuedAt: number;
  expiresAt: number;
}

export interface SenderCertificate {
  payload: SenderCertificatePayload;
  signature: string;
}

function cacheKey(userId: string, deviceId: string, fingerprint: string, identityEpoch: number): string {
  return `${userId}::${deviceId}::${fingerprint}::${identityEpoch}`;
}

async function signPayload(userId: string, payload: SenderCertificatePayload): Promise<string> {
  const keys = await loadIdentityKeys(userId);
  if (!keys) throw new Error('NO_IDENTITY_FOR_SENDER_CERTIFICATE');

  const bytes = new hardGlobals.TextEncoder().encode(JSON.stringify(payload));
  const sig = await hardCrypto.sign('Ed25519' as any, keys.signingPrivateKey, bytes);
  return bufferToBase64(sig);
}

function publishSenderCertificate(cert: SenderCertificate): void {
  const payload = cert.payload;
  void supabase
    .from('user_sender_certificates' as any)
    .upsert({
      user_id: payload.userId,
      device_id: payload.deviceId,
      identity_epoch: payload.identityEpoch,
      fingerprint: payload.fingerprint,
      payload: JSON.stringify(payload),
      signature: cert.signature,
      issued_at: new Date(payload.issuedAt).toISOString(),
      expires_at: new Date(payload.expiresAt).toISOString(),
    }, { onConflict: 'user_id,device_id,identity_epoch' })
    .then(({ error }) => {
      if (error) console.warn('[E2EE][CERT] sender certificate publish skipped', error);
    })
    .catch((error) => console.warn('[E2EE][CERT] sender certificate publish skipped', error));
}

export async function issueSenderCertificate(userId: string, fingerprint: string): Promise<SenderCertificate> {
  const now = Date.now();
  const deviceId = getOrCreateCurrentDeviceId();
  const identityEpoch = getLocalSecurityEpoch(userId);
  const key = cacheKey(userId, deviceId, fingerprint, identityEpoch);
  const cached = certCache.get(key);
  if (cached && cached.payload.expiresAt > now + CERT_REFRESH_SKEW_MS) {
    return cached;
  }

  const payload: SenderCertificatePayload = {
    version: 1,
    userId,
    deviceId,
    fingerprint,
    identityEpoch,
    issuedAt: now,
    expiresAt: now + CERT_TTL_MS,
  };

  const cert: SenderCertificate = {
    payload,
    signature: await signPayload(userId, payload),
  };

  certCache.set(key, cert);
  publishSenderCertificate(cert);

  return cert;
}

export function isSenderCertificateExpired(cert: SenderCertificate): boolean {
  return cert.payload.expiresAt <= Date.now();
}

export async function fetchSenderCertificate(userId: string, deviceId?: string): Promise<SenderCertificate | null> {
  let query = supabase
    .from('user_sender_certificates' as any)
    .select('payload, signature, expires_at')
    .eq('user_id', userId)
    .gt('expires_at', new Date().toISOString())
    .order('expires_at', { ascending: false })
    .limit(1);

  if (deviceId) query = query.eq('device_id', deviceId);

  const { data } = await query.maybeSingle();
  const row = data as any;
  if (!row?.payload || !row?.signature) return null;

  return {
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    signature: row.signature,
  };
}

export function senderCertificateAAD(cert: SenderCertificate): string {
  return bufferToBase64(new hardGlobals.TextEncoder().encode(JSON.stringify(cert.payload)).buffer);
}
