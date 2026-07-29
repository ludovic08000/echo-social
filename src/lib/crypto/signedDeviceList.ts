import { supabase } from '@/integrations/supabase/client';
import { verifyDeviceIdentityBinding } from './deviceIdentity';

export interface SignedDeviceEntry {
  deviceId: string;
  devicePublicKey: string;
  deviceSigningKey: string;
  identitySignature: string;
  identityVersion: number;
  lastSeenAt: string | null;
}

export interface DeviceVerificationResult {
  deviceId: string;
  ok: boolean;
  reason?:
    | 'VALID'
    | 'NO_IDENTITY'
    | 'UNSUPPORTED_IDENTITY_VERSION'
    | 'BAD_DEVICE_IDENTITY_SIGNATURE';
}

type SesameDeviceRow = {
  device_id: string;
  device_public_key: string;
  device_signing_key: string;
  device_identity_signature: string;
  device_identity_version: number;
  last_seen_at: string | null;
};

export async function fetchSignedDeviceList(userId: string): Promise<SignedDeviceEntry[]> {
  if (!userId) return [];
  const { data, error } = await (supabase as any).rpc('get_sesame_device_list', {
    p_user_id: userId,
  });
  if (error) throw error;

  return ((data ?? []) as unknown as SesameDeviceRow[]).map((row) => ({
    deviceId: row.device_id,
    devicePublicKey: row.device_public_key,
    deviceSigningKey: row.device_signing_key,
    identitySignature: row.device_identity_signature,
    identityVersion: Number(row.device_identity_version ?? 0),
    lastSeenAt: row.last_seen_at ?? null,
  }));
}

export async function verifySignedDeviceList(
  userId: string,
  list: SignedDeviceEntry[],
): Promise<DeviceVerificationResult[]> {
  return Promise.all(list.map(async (entry): Promise<DeviceVerificationResult> => {
    if (
      !entry.devicePublicKey ||
      !entry.deviceSigningKey ||
      !entry.identitySignature
    ) {
      return { deviceId: entry.deviceId, ok: false, reason: 'NO_IDENTITY' };
    }
    if (entry.identityVersion !== 1) {
      return {
        deviceId: entry.deviceId,
        ok: false,
        reason: 'UNSUPPORTED_IDENTITY_VERSION',
      };
    }

    const ok = await verifyDeviceIdentityBinding({
      userId,
      deviceId: entry.deviceId,
      devicePublicKey: entry.devicePublicKey,
      signingPublicKey: entry.deviceSigningKey,
      signature: entry.identitySignature,
    });
    return {
      deviceId: entry.deviceId,
      ok,
      reason: ok ? 'VALID' : 'BAD_DEVICE_IDENTITY_SIGNATURE',
    };
  }));
}

export async function fetchTrustedDeviceList(userId: string): Promise<SignedDeviceEntry[]> {
  const list = await fetchSignedDeviceList(userId);
  const verification = await verifySignedDeviceList(userId, list);
  const trustedIds = new Set(
    verification.filter((result) => result.ok).map((result) => result.deviceId),
  );
  return list.filter((entry) => trustedIds.has(entry.deviceId));
}

export async function fetchVerifiedDeviceList(userId: string): Promise<{
  signedListPresent: boolean;
  trusted: SignedDeviceEntry[];
  verifications: DeviceVerificationResult[];
}> {
  const list = await fetchSignedDeviceList(userId);
  const verifications = await verifySignedDeviceList(userId, list);
  const trustedIds = new Set(
    verifications.filter((result) => result.ok).map((result) => result.deviceId),
  );
  return {
    signedListPresent: list.length > 0,
    trusted: list.filter((entry) => trustedIds.has(entry.deviceId)),
    verifications,
  };
}

export const __test__ = {
  verifyDeviceIdentityBinding,
};
