import { supabase } from '@/integrations/supabase/client';
import { getApprovedDeviceIdentity, type CanonicalDeviceIdentity } from './deviceLinkTrust';

export type CanonicalRoutableDevice = CanonicalDeviceIdentity & {
  lastSeenAt: string | null;
  isRoutable: boolean;
};

type ActiveDeviceRow = {
  device_id: string;
  device_public_key: string | null;
  last_seen_at?: string | null;
};

export async function fetchVerifiedDeviceIdentity(
  userId: string,
  deviceId: string,
): Promise<CanonicalRoutableDevice | null> {
  try {
    const identity = await getApprovedDeviceIdentity(userId, deviceId);
    return { ...identity, lastSeenAt: null, isRoutable: true };
  } catch {
    return null;
  }
}

export async function fetchVerifiedDeviceList(userId: string): Promise<{
  signedListPresent: boolean;
  trusted: CanonicalRoutableDevice[];
  verifications: Array<{ deviceId: string; isRoutable: boolean; ok: boolean; reason: string }>;
}> {
  const { data, error } = await (supabase as any).rpc('list_active_devices_for_user', {
    p_user_id: userId,
  });
  if (error) throw new Error('DEVICE_REGISTRY_LOOKUP_FAILED');

  const rows = (data ?? []) as ActiveDeviceRow[];
  const settled = await Promise.all(rows.map(async (row) => {
    try {
      const identity = await getApprovedDeviceIdentity(userId, row.device_id);
      return {
        device: { ...identity, lastSeenAt: row.last_seen_at ?? null, isRoutable: true },
        verification: { deviceId: row.device_id, isRoutable: true, ok: true, reason: 'VALID' },
      };
    } catch (error) {
      return {
        device: null,
        verification: {
          deviceId: row.device_id,
          isRoutable: true,
          ok: false,
          reason: error instanceof Error ? error.message : 'DEVICE_AUTHORIZATION_INVALID',
        },
      };
    }
  }));

  return {
    signedListPresent: rows.length > 0,
    trusted: settled.flatMap((entry) => entry.device ? [entry.device] : []),
    verifications: settled.map((entry) => entry.verification),
  };
}

export async function fetchTrustedDeviceList(userId: string): Promise<CanonicalRoutableDevice[]> {
  return (await fetchVerifiedDeviceList(userId)).trusted;
}
