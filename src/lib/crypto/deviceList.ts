import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from './cryptoIntegrity';
import {
  isCryptographicallyTrustedDevice,
  loadTrustedDevice,
  saveTrustedDevice,
} from './deviceTrust';

const DEVICE_ID_KEY = 'forsure-current-device-id-v2';
const MAX_DEVICE_STALE_MS = 90 * 24 * 60 * 60 * 1000;

export interface DeviceListEntry {
  deviceId: string;
  userId: string;
  fingerprint: string;
  identityEpoch: number;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}

export class DeviceRevokedError extends Error {
  constructor(deviceId: string) {
    super(`DEVICE_REVOKED: ${deviceId}`);
    this.name = 'DeviceRevokedError';
  }
}

export function getOrCreateCurrentDeviceId(): string {
  const existing = localStorage.getItem(DEVICE_ID_KEY);
  if (existing && existing.length >= 16) return existing;

  const bytes = hardCrypto.getRandomValues(new Uint8Array(16));
  const generated = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(DEVICE_ID_KEY, generated);
  return generated;
}

export async function publishCurrentDevice(
  userId: string,
  fingerprint: string,
  identityEpoch: number,
): Promise<DeviceListEntry> {
  const deviceId = getOrCreateCurrentDeviceId();
  const now = new Date().toISOString();

  const { data: existing, error: readError } = await supabase
    .from('user_devices' as any)
    .select('created_at, last_seen_at, revoked_at')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();

  if (readError) throw readError;
  if ((existing as any)?.revoked_at) throw new DeviceRevokedError(deviceId);

  const { error: publishError } = await supabase
    .from('user_devices' as any)
    .upsert({
      user_id: userId,
      device_id: deviceId,
      device_fingerprint: fingerprint,
      last_seen_at: now,
      // revoked_at is intentionally omitted. A revoked device cannot clear its
      // own revocation merely by retaining an old authenticated session.
    }, { onConflict: 'user_id,device_id' });

  if (publishError) throw publishError;

  const cached = loadTrustedDevice(userId, deviceId);
  const remainsTrusted = isCryptographicallyTrustedDevice(cached);
  saveTrustedDevice({
    userId,
    deviceId,
    fingerprint,
    signedBy: remainsTrusted ? cached?.signedBy : undefined,
    trustLevel: remainsTrusted ? 'trusted' : 'unverified',
    createdAt: cached?.createdAt ?? Date.now(),
    lastSeenAt: Date.now(),
  });

  return {
    deviceId,
    userId,
    fingerprint,
    identityEpoch,
    createdAt: (existing as any)?.created_at || now,
    lastSeenAt: now,
    revokedAt: null,
  };
}

function isFresh(lastSeenAt: string | null | undefined): boolean {
  if (!lastSeenAt) return false;
  const ts = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= MAX_DEVICE_STALE_MS;
}

async function hasAvailableDeviceOneTimePrekey(userId: string, deviceId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('count_device_one_time_prekeys', {
      p_user_id: userId,
      p_device_id: deviceId,
    });
    if (error) return false;
    return Number(data ?? 0) > 0;
  } catch {
    return false;
  }
}

async function hasValidDevicePrekey(userId: string, deviceId: string): Promise<boolean> {
  try {
    const { peekDeviceSignedPrekey } = await import('./x3dh');
    const spk = await peekDeviceSignedPrekey(userId, deviceId);
    if (!spk) return false;

    // The conversation-level hook cannot safely distinguish a device-scoped
    // 3-DH SPK from the legacy account SPK. Select the device route only when
    // an OPK is available, so the initial header carries opkId and the receiver
    // is deterministically routed through x3dhRespondForDevice().
    return hasAvailableDeviceOneTimePrekey(userId, deviceId);
  } catch (error) {
    console.warn('[E2EE][DEVICE_LIST] skipping device with invalid X3DH prekey', {
      userId,
      deviceId,
      error,
    });
    return false;
  }
}

export async function fetchActiveDevices(userId: string): Promise<DeviceListEntry[]> {
  const { data, error } = await supabase
    .from('user_devices' as any)
    .select('user_id, device_id, device_fingerprint, created_at, last_seen_at, revoked_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('last_seen_at', { ascending: false });

  if (error) {
    console.warn('[E2EE][DEVICE_LIST] active device fetch failed', { userId, error });
    return [];
  }

  const mapped = ((data || []) as any[])
    .filter((row) => row.device_id)
    .filter((row) => isFresh(row.last_seen_at))
    .map((row) => ({
      userId: row.user_id,
      deviceId: row.device_id,
      fingerprint: row.device_fingerprint || '',
      identityEpoch: 1,
      createdAt: row.created_at || row.last_seen_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at || null,
    }));

  if (mapped.length === 0) return [];

  const verified = await Promise.all(mapped.map(async (device) => {
    const ok = await hasValidDevicePrekey(device.userId, device.deviceId);
    return ok ? device : null;
  }));

  return verified.filter(Boolean) as DeviceListEntry[];
}

export async function revokeCurrentDevice(userId: string): Promise<void> {
  const deviceId = getOrCreateCurrentDeviceId();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('user_devices' as any)
    .update({ revoked_at: now, last_seen_at: now } as any)
    .eq('user_id', userId)
    .eq('device_id', deviceId);

  if (error) throw error;
}
