import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from './cryptoIntegrity';
import { saveTrustedDevice } from './deviceTrust';

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

  await supabase
    .from('user_devices' as any)
    .upsert({
      user_id: userId,
      device_id: deviceId,
      device_fingerprint: fingerprint,
      last_seen_at: now,
      revoked_at: null,
    }, { onConflict: 'user_id,device_id' });

  saveTrustedDevice({
    userId,
    deviceId,
    fingerprint,
    trustLevel: 'trusted',
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  });

  return {
    deviceId,
    userId,
    fingerprint,
    identityEpoch,
    createdAt: now,
    lastSeenAt: now,
    revokedAt: null,
  };
}

function isFresh(lastSeenAt: string | null | undefined): boolean {
  if (!lastSeenAt) return true;
  const ts = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts <= MAX_DEVICE_STALE_MS;
}

async function hasValidDevicePrekey(userId: string, deviceId: string): Promise<boolean> {
  try {
    const { peekDeviceSignedPrekey } = await import('./x3dh');
    const spk = await peekDeviceSignedPrekey(userId, deviceId);
    return !!spk;
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
  const { data } = await supabase
    .from('user_devices' as any)
    .select('user_id, device_id, device_fingerprint, created_at, last_seen_at, revoked_at, stale_at, approval_status, is_active, device_public_key')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('last_seen_at', { ascending: false });

  const raw = ((data || []) as any[])
    .filter((row) => row.device_id)
    .filter((row) => row.is_active !== false)
    .filter((row) => !row.stale_at)
    .filter((row) => (row.approval_status ?? 'approved') === 'approved')
    .filter((row) => isFresh(row.last_seen_at));

  const mapped = raw.map((row) => ({
    userId: row.user_id,
    deviceId: row.device_id,
    fingerprint: row.device_fingerprint || '',
    identityEpoch: 1,
    createdAt: row.created_at || row.last_seen_at || new Date().toISOString(),
    lastSeenAt: row.last_seen_at || new Date().toISOString(),
    revokedAt: row.revoked_at || null,
  }));

  if (mapped.length <= 1) return mapped;

  const verified = await Promise.all(mapped.map(async (device) => {
    const ok = await hasValidDevicePrekey(device.userId, device.deviceId);
    return ok ? device : null;
  }));

  const valid = verified.filter(Boolean) as DeviceListEntry[];
  return valid.length > 0 ? valid : mapped;
}

export async function revokeCurrentDevice(userId: string): Promise<void> {
  const deviceId = getOrCreateCurrentDeviceId();
  const now = new Date().toISOString();

  await supabase
    .from('user_devices' as any)
    .update({ revoked_at: now, last_seen_at: now } as any)
    .eq('user_id', userId)
    .eq('device_id', deviceId);
}
