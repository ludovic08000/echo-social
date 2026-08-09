import { supabase } from '@/integrations/supabase/client';
import { verifyPublicIdentityBinding } from './keyManager';
import { verifyDeviceAuthorization } from './deviceIdentity';
import { peekDeviceSignedPrekey } from './x3dh';

type AccountIdentityRow = {
  identity_key: string;
  signing_key: string;
  fingerprint: string;
  identity_binding_signature: string;
  identity_binding_version: number;
};

type CanonicalDeviceRow = {
  device_id: string;
  device_public_key: string | null;
  device_signing_key: string | null;
  device_authorization_signature: string | null;
  approval_status: string | null;
  binding_status: string | null;
  routing_status: string | null;
  is_active: boolean | null;
  revoked_at: string | null;
  stale_at: string | null;
  crypto_invalid_at: string | null;
};

async function readAccountIdentity(userId: string): Promise<AccountIdentityRow> {
  const { data, error } = await supabase
    .from('user_public_keys')
    .select('identity_key,signing_key,fingerprint,identity_binding_signature,identity_binding_version')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) throw new Error('ACCOUNT_IDENTITY_NOT_FOUND');

  const account = data as AccountIdentityRow;
  const valid = await verifyPublicIdentityBinding({
    identityKey: account.identity_key,
    signingKey: account.signing_key,
    fingerprint: account.fingerprint,
    bindingVersion: Number(account.identity_binding_version),
    bindingSignature: account.identity_binding_signature,
  });
  if (!valid) throw new Error('ACCOUNT_IDENTITY_BINDING_INVALID');
  return account;
}

function assertCanonicalRoute(device: CanonicalDeviceRow): void {
  if (
    device.approval_status !== 'approved'
    || device.is_active !== true
    || device.revoked_at
    || device.stale_at
    || device.crypto_invalid_at
  ) {
    throw new Error('DEVICE_ROUTE_NOT_AUTHORIZED');
  }
  if (device.binding_status !== 'bound') throw new Error('DEVICE_ACCOUNT_BINDING_REQUIRED');
  if (device.routing_status !== 'ready') throw new Error('DEVICE_ROUTE_NOT_READY');
  if (!device.device_public_key || !device.device_signing_key || !device.device_authorization_signature) {
    throw new Error('DEVICE_AUTHORIZATION_INCOMPLETE');
  }
}

async function verifyCanonicalDevice(
  userId: string,
  device: CanonicalDeviceRow,
  account: AccountIdentityRow,
): Promise<void> {
  assertCanonicalRoute(device);
  const authorized = await verifyDeviceAuthorization({
    userId,
    deviceId: device.device_id,
    accountFingerprint: account.fingerprint,
    accountSigningKey: account.signing_key,
    devicePublicKey: device.device_public_key!,
    deviceSigningKey: device.device_signing_key!,
    authorizationSignature: device.device_authorization_signature!,
  });
  if (!authorized) throw new Error('DEVICE_AUTHORIZATION_INVALID');

  const spk = await peekDeviceSignedPrekey(userId, device.device_id).catch(() => null);
  if (!spk) throw new Error('DEVICE_SIGNED_PREKEY_UNAVAILABLE');
}

/**
 * Verify one canonical device directly from the account-bound registry.
 * No primary-device, signed-list, fingerprint-recovery or cross-device trust
 * layer participates in this decision.
 */
export async function ensureApprovedDeviceTrust(
  userId: string,
  deviceId: string,
): Promise<number> {
  if (!userId || !deviceId) throw new Error('DEVICE_TRUST_INPUT_INVALID');
  const [{ data, error }, account] = await Promise.all([
    supabase
      .from('user_devices')
      .select('*')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .maybeSingle(),
    readAccountIdentity(userId),
  ]);
  if (error || !data) throw new Error('DEVICE_NOT_FOUND');
  await verifyCanonicalDevice(userId, data as unknown as CanonicalDeviceRow, account);
  return 0;
}

/**
 * Validate every currently active canonical route. Historical revoked/stale
 * rows are ignored; an active malformed route is counted as invalid.
 */
export async function repairApprovedDeviceTrust(userId: string): Promise<number> {
  if (!userId) throw new Error('DEVICE_TRUST_INPUT_INVALID');
  const [{ data, error }, account] = await Promise.all([
    supabase
      .from('user_devices')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .is('revoked_at', null),
    readAccountIdentity(userId),
  ]);
  if (error) throw new Error('DEVICE_REGISTRY_LOOKUP_FAILED');

  const devices = (data ?? []) as unknown as CanonicalDeviceRow[];
  if (devices.length === 0) throw new Error('DEVICE_REGISTRY_CONTAINS_NO_VALID_ROUTE');

  let validCount = 0;
  let invalidCount = 0;
  for (const device of devices) {
    try {
      await verifyCanonicalDevice(userId, device, account);
      validCount += 1;
    } catch {
      invalidCount += 1;
    }
  }
  if (validCount === 0) throw new Error('DEVICE_REGISTRY_CONTAINS_NO_VALID_ROUTE');
  return invalidCount;
}
