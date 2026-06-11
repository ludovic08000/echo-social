import { supabase } from '@/integrations/supabase/client';
import { hardCrypto } from './cryptoIntegrity';
import { saveTrustedDevice } from './deviceTrust';

const DEVICE_ID_KEY = 'forsure-current-device-id-v2';

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

export async function fetchActiveDevices(userId: string): Promise<DeviceListEntry[]> {
  const { data } = await supabase
    .from('user_devices' as any)
    .select('user_id, device_id, device_fingerprint, created_at, last_seen_at, revoked_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('last_seen_at', { ascending: false });

  return ((data || []) as any[]).map((row) => ({
    userId: row.user_id,
    deviceId: row.device_id,
    fingerprint: row.device_fingerprint || '',
    identityEpoch: 1,
    createdAt: row.created_at || row.last_seen_at || new Date().toISOString(),
    lastSeenAt: row.last_seen_at || new Date().toISOString(),
    revokedAt: row.revoked_at || null,
  }));
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
