import { supabase } from '@/integrations/supabase/client';
import { verifyPublicIdentityBinding } from './keyManager';
import { verifyDeviceAuthorization } from './deviceIdentity';

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

export type CanonicalDeviceIdentity = {
  deviceId: string;
  devicePublicKey: string;
  deviceSigningKey: string;
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
): Promise<CanonicalDeviceIdentity> {
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
  return {
    deviceId: device.device_id,
    devicePublicKey: device.device_public_key!,
    deviceSigningKey: device.device_signing_key!,
  };
}

async function readCanonicalDevice(userId: string, deviceId: string): Promise<CanonicalDeviceRow> {
  const { data, error } = await supabase.rpc('get_canonical_remote_device_identity' as never, {
    p_user_id: userId,
    p_device_id: deviceId,
  } as never);
  if (error) {
    console.error('[E2EE][DEVICE_TRUST] canonical RPC failed', { userId, deviceId, code: error.code, message: error.message });
    throw new Error('DEVICE_REGISTRY_LOOKUP_FAILED');
  }
  const payload = data as unknown;
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (!row) throw new Error('DEVICE_NOT_FOUND');
  return row as unknown as CanonicalDeviceRow;
}

/** Verify one canonical device through the RLS-safe public cryptographic registry RPC. */
export async function getApprovedDeviceIdentity(
  userId: string,
  deviceId: string,
): Promise<CanonicalDeviceIdentity> {
  if (!userId || !deviceId) throw new Error('DEVICE_TRUST_INPUT_INVALID');
  const [device, account] = await Promise.all([
    readCanonicalDevice(userId, deviceId),
    readAccountIdentity(userId),
  ]);
  return verifyCanonicalDevice(userId, device, account);
}

/**
 * Invariant corrigé : une route déjà validée par le module de routage serveur
 * est vérifiée cryptographiquement hors-ligne, sans RPC supplémentaire. Une
 * panne réseau ne peut donc plus faire disparaître un destinataire valide
 * (E2EE_PARTICIPANT_ROUTE_UNAVAILABLE), seule une signature invalide rejette.
 */
export async function verifyRouteDeviceIdentityOffline(args: {
  userId: string;
  deviceId: string;
  devicePublicKey: string | null;
  deviceSigningKey: string | null;
  deviceAuthorizationSignature: string | null;
  accountIdentityKey: string | null;
  accountSigningKey: string | null;
  accountFingerprint: string | null;
  accountBindingSignature: string | null;
  accountBindingVersion: number | null;
}): Promise<CanonicalDeviceIdentity | null> {
  if (
    !args.userId || !args.deviceId
    || !args.devicePublicKey || !args.deviceSigningKey || !args.deviceAuthorizationSignature
    || !args.accountIdentityKey || !args.accountSigningKey || !args.accountFingerprint
    || !args.accountBindingSignature
  ) return null;

  const bindingValid = await verifyPublicIdentityBinding({
    identityKey: args.accountIdentityKey,
    signingKey: args.accountSigningKey,
    fingerprint: args.accountFingerprint,
    bindingVersion: Number(args.accountBindingVersion ?? 0),
    bindingSignature: args.accountBindingSignature,
  });
  if (!bindingValid) return null;

  const authorized = await verifyDeviceAuthorization({
    userId: args.userId,
    deviceId: args.deviceId,
    accountFingerprint: args.accountFingerprint,
    accountSigningKey: args.accountSigningKey,
    devicePublicKey: args.devicePublicKey,
    deviceSigningKey: args.deviceSigningKey,
    authorizationSignature: args.deviceAuthorizationSignature,
  });
  if (!authorized) return null;

  return {
    deviceId: args.deviceId,
    devicePublicKey: args.devicePublicKey,
    deviceSigningKey: args.deviceSigningKey,
  };
}

export async function ensureApprovedDeviceTrust(userId: string, deviceId: string): Promise<number> {
  await getApprovedDeviceIdentity(userId, deviceId);
  return 0;
}

/** Validate every route returned by the canonical Sesame registry, without direct cross-user table reads. */
export async function repairApprovedDeviceTrust(userId: string): Promise<number> {
  if (!userId) throw new Error('DEVICE_TRUST_INPUT_INVALID');
  const { data, error } = await supabase.rpc('get_sesame_device_list' as never, { p_user_id: userId } as never);
  if (error) throw new Error('DEVICE_REGISTRY_LOOKUP_FAILED');
  const rows = Array.isArray(data) ? data : [];
  const ids = rows
    .filter((row: any) => row?.is_routable === true && typeof row?.device_id === 'string')
    .map((row: any) => row.device_id as string);
  if (ids.length === 0) throw new Error('DEVICE_REGISTRY_CONTAINS_NO_VALID_ROUTE');

  let validCount = 0;
  let invalidCount = 0;
  for (const deviceId of ids) {
    try {
      await getApprovedDeviceIdentity(userId, deviceId);
      validCount += 1;
    } catch {
      invalidCount += 1;
    }
  }
  if (validCount === 0) throw new Error('DEVICE_REGISTRY_CONTAINS_NO_VALID_ROUTE');
  return invalidCount;
}
