import { supabase } from '@/integrations/supabase/client';
import { verifyPublicIdentityBinding } from './keyManager';
import { verifyDeviceAuthorization } from './deviceIdentity';

export interface SignedDeviceEntry {
  deviceId: string;
  devicePublicKey: string;
  deviceSigningKey: string;
  authorizationSignature: string;
  lastSeenAt: string | null;
  accountIdentityKey: string;
  accountSigningKey: string;
  accountFingerprint: string;
  accountBindingSignature: string;
  accountBindingVersion: number;
}

export interface DeviceVerificationResult {
  deviceId: string;
  ok: boolean;
  reason?:
    | 'VALID'
    | 'NO_ACCOUNT_IDENTITY'
    | 'BAD_ACCOUNT_IDENTITY_BINDING'
    | 'NO_DEVICE_AUTHORIZATION'
    | 'BAD_DEVICE_AUTHORIZATION';
}

type SesameDeviceRow = {
  device_id: string;
  device_public_key: string;
  device_signing_key: string;
  device_authorization_signature: string;
  last_seen_at: string | null;
  account_identity_key: string;
  account_signing_key: string;
  account_fingerprint: string;
  account_binding_signature: string;
  account_binding_version: number;
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
    authorizationSignature: row.device_authorization_signature,
    lastSeenAt: row.last_seen_at ?? null,
    accountIdentityKey: row.account_identity_key,
    accountSigningKey: row.account_signing_key,
    accountFingerprint: row.account_fingerprint,
    accountBindingSignature: row.account_binding_signature,
    accountBindingVersion: Number(row.account_binding_version),
  }));
}

export async function verifySignedDeviceList(
  userId: string,
  list: SignedDeviceEntry[],
): Promise<DeviceVerificationResult[]> {
  if (list.length === 0) return [];

  const root = list[0];
  const rootFieldsPresent = Boolean(
    root.accountIdentityKey &&
    root.accountSigningKey &&
    root.accountFingerprint &&
    root.accountBindingSignature,
  );
  if (!rootFieldsPresent) {
    return list.map((entry) => ({
      deviceId: entry.deviceId,
      ok: false,
      reason: 'NO_ACCOUNT_IDENTITY',
    }));
  }

  const rootConsistent = list.every((entry) =>
    entry.accountIdentityKey === root.accountIdentityKey &&
    entry.accountSigningKey === root.accountSigningKey &&
    entry.accountFingerprint === root.accountFingerprint &&
    entry.accountBindingSignature === root.accountBindingSignature &&
    entry.accountBindingVersion === root.accountBindingVersion,
  );
  const rootValid = rootConsistent && await verifyPublicIdentityBinding({
    identityKey: root.accountIdentityKey,
    signingKey: root.accountSigningKey,
    fingerprint: root.accountFingerprint,
    bindingVersion: root.accountBindingVersion,
    bindingSignature: root.accountBindingSignature,
  });
  if (!rootValid) {
    return list.map((entry) => ({
      deviceId: entry.deviceId,
      ok: false,
      reason: 'BAD_ACCOUNT_IDENTITY_BINDING',
    }));
  }

  return Promise.all(list.map(async (entry): Promise<DeviceVerificationResult> => {
    if (
      !entry.devicePublicKey ||
      !entry.deviceSigningKey ||
      !entry.authorizationSignature
    ) {
      return { deviceId: entry.deviceId, ok: false, reason: 'NO_DEVICE_AUTHORIZATION' };
    }

    const ok = await verifyDeviceAuthorization({
      userId,
      deviceId: entry.deviceId,
      accountFingerprint: root.accountFingerprint,
      accountSigningKey: root.accountSigningKey,
      devicePublicKey: entry.devicePublicKey,
      deviceSigningKey: entry.deviceSigningKey,
      authorizationSignature: entry.authorizationSignature,
    });
    return {
      deviceId: entry.deviceId,
      ok,
      reason: ok ? 'VALID' : 'BAD_DEVICE_AUTHORIZATION',
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

export async function fetchVerifiedDeviceIdentity(
  userId: string,
  deviceId: string,
): Promise<SignedDeviceEntry | null> {
  const verified = await fetchVerifiedDeviceList(userId);
  return verified.trusted.find((entry) => entry.deviceId === deviceId) ?? null;
}

export const __test__ = {
  verifyDeviceAuthorization,
};
