import { supabase } from '@/integrations/supabase/client';
import type {
  DeviceIdentityKey,
  PreparedDeviceAuthorization,
} from '@/lib/crypto/deviceIdentity';
import type { DeviceKxKey } from '@/lib/crypto/deviceKx';
import { signDeviceEnrollmentPossession } from '@/lib/crypto/deviceEnrollmentPossession';
import { getCurrentPlatform } from '@/lib/messaging/currentDevice';

const SERVER_DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RpcObject = Record<string, unknown>;
export type DevicePlatform = 'ios' | 'android' | 'web';

export interface DeviceEnrollmentMetadata {
  deviceName: string;
  deviceFingerprint: string | null;
  platform: DevicePlatform;
  userAgent: string | null;
}

export interface DeviceEnrollmentChallenge {
  challengeId: string;
  deviceId: string;
  nonce: string;
  expiresAt: string;
}

export interface PendingDeviceCandidate {
  accountFingerprint: string;
  deviceKx: DeviceKxKey;
  deviceSigning: DeviceIdentityKey;
}

export type DeviceEnrollmentSettlement = {
  status: 'completed' | 'cancelled';
  deviceId: string;
};

export interface RegisteredDeviceReuseState {
  isActive?: unknown;
  approvalStatus?: unknown;
  revokedAt?: unknown;
  cryptoInvalidAt?: unknown;
}

function asObject(value: unknown): RpcObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DEVICE_ENROLLMENT_INVALID_RESPONSE');
  }
  return value as RpcObject;
}

function responseCode(value: RpcObject): string {
  return typeof value.code === 'string' && value.code.length > 0
    ? value.code
    : 'DEVICE_ENROLLMENT_RPC_REJECTED';
}

function normalizeDevicePlatform(value: unknown): DevicePlatform {
  const platform = String(value ?? '').toLowerCase();
  if (platform === 'ios' || platform === 'android') return platform;
  return 'web';
}

export function isRegisteredDeviceReusable(
  serverPlatform: unknown,
  runtimePlatform: unknown,
  state?: RegisteredDeviceReuseState,
): boolean {
  if (state) {
    const approvalStatus = String(state.approvalStatus ?? 'approved').toLowerCase();
    if (
      state.isActive !== true
      || approvalStatus !== 'approved'
      || state.revokedAt != null
      || state.cryptoInvalidAt != null
    ) {
      return false;
    }
  }

  return normalizeDevicePlatform(serverPlatform) === normalizeDevicePlatform(runtimePlatform);
}

export function parseDeviceEnrollmentChallenge(value: unknown): DeviceEnrollmentChallenge {
  const result = asObject(value);
  if (result.ok !== true) throw new Error(responseCode(result));

  const challengeId = typeof result.challenge_id === 'string' ? result.challenge_id : '';
  const deviceId = typeof result.device_id === 'string' ? result.device_id : '';
  const nonce = typeof result.nonce === 'string' ? result.nonce : '';
  const expiresAt = typeof result.expires_at === 'string' ? result.expires_at : '';

  if (!UUID_RE.test(challengeId)) throw new Error('DEVICE_ENROLLMENT_INVALID_CHALLENGE_ID');
  if (!SERVER_DEVICE_ID_RE.test(deviceId)) throw new Error('DEVICE_ENROLLMENT_INVALID_DEVICE_ID');
  if (nonce.length < 32) throw new Error('DEVICE_ENROLLMENT_INVALID_NONCE');
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) {
    throw new Error('DEVICE_ENROLLMENT_INVALID_EXPIRY');
  }
  if (Date.parse(expiresAt) <= Date.now()) throw new Error('DEVICE_ENROLLMENT_EXPIRED');

  return { challengeId, deviceId, nonce, expiresAt };
}

export function parseCompletedDeviceEnrollment(
  value: unknown,
  expectedDeviceId: string,
): string {
  const result = asObject(value);
  if (result.ok !== true) throw new Error(responseCode(result));

  const code = responseCode(result);
  if (code !== 'DEVICE_ENROLLMENT_COMPLETED' && code !== 'DEVICE_ENROLLMENT_ALREADY_COMPLETED') {
    throw new Error('DEVICE_ENROLLMENT_NOT_STAGED');
  }

  const deviceId = typeof result.device_id === 'string' ? result.device_id : '';
  if (!SERVER_DEVICE_ID_RE.test(deviceId)) {
    throw new Error('DEVICE_ENROLLMENT_INVALID_DEVICE_ID');
  }
  if (deviceId !== expectedDeviceId) {
    throw new Error('DEVICE_ENROLLMENT_SERVER_ID_MISMATCH');
  }
  return deviceId;
}

export function parseApprovedDevice(
  value: unknown,
  expectedDeviceId: string,
): string {
  const result = asObject(value);
  if (result.ok !== true) throw new Error(responseCode(result));
  if (responseCode(result) !== 'DEVICE_APPROVED') {
    throw new Error('DEVICE_APPROVAL_INVALID_RESPONSE');
  }

  const deviceId = typeof result.device_id === 'string' ? result.device_id : '';
  if (!SERVER_DEVICE_ID_RE.test(deviceId)) {
    throw new Error('DEVICE_APPROVAL_INVALID_DEVICE_ID');
  }
  if (deviceId !== expectedDeviceId) {
    throw new Error('DEVICE_APPROVAL_SERVER_ID_MISMATCH');
  }
  return deviceId;
}

export function parseDeviceEnrollmentSettlement(
  value: unknown,
  expectedDeviceId: string,
): DeviceEnrollmentSettlement {
  const result = asObject(value);
  if (result.ok !== true) throw new Error(responseCode(result));

  const deviceId = typeof result.device_id === 'string' ? result.device_id : '';
  if (!SERVER_DEVICE_ID_RE.test(deviceId)) {
    throw new Error('DEVICE_ENROLLMENT_INVALID_DEVICE_ID');
  }
  if (deviceId !== expectedDeviceId) {
    throw new Error('DEVICE_ENROLLMENT_SERVER_ID_MISMATCH');
  }

  const code = responseCode(result);
  if (code === 'DEVICE_ENROLLMENT_ALREADY_COMPLETED') {
    return { status: 'completed', deviceId };
  }
  if (code === 'DEVICE_ENROLLMENT_CANCELLED' || code === 'DEVICE_ENROLLMENT_ALREADY_CANCELLED') {
    return { status: 'cancelled', deviceId };
  }
  throw new Error('DEVICE_ENROLLMENT_INVALID_SETTLEMENT');
}

export async function hasRegisteredDevice(
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('device_id,platform,is_active,approval_status,revoked_at,crypto_invalid_at')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();

  if (error) throw new Error(`DEVICE_ROUTE_LOOKUP_FAILED:${error.message}`);
  if (!data?.device_id) return false;

  const runtimePlatform = normalizeDevicePlatform(getCurrentPlatform());
  const reusable = isRegisteredDeviceReusable(data.platform, runtimePlatform, {
    isActive: data.is_active,
    approvalStatus: data.approval_status,
    revokedAt: data.revoked_at,
    cryptoInvalidAt: data.crypto_invalid_at,
  });

  if (!reusable) {
    console.warn('[e2ee] refusing stale, revoked or cross-platform DeviceID reuse', {
      serverPlatform: normalizeDevicePlatform(data.platform),
      runtimePlatform,
      active: data.is_active === true,
      approved: String(data.approval_status ?? 'approved').toLowerCase() === 'approved',
      revoked: data.revoked_at != null,
      cryptoInvalid: data.crypto_invalid_at != null,
    });
    return false;
  }

  return true;
}

/**
 * Existing accounts use their active server fingerprint. If the public row is
 * temporarily absent but an encrypted recovery vault remains, its pinned
 * fingerprint is authoritative and keeps the device in account-recovery mode.
 *
 * A fresh identity may be generated only when there is no public identity, no
 * recovery vault, no backup and no device history. Any other continuity
 * evidence fails closed instead of silently replacing the account root.
 */
export async function readActiveAccountFingerprint(userId: string): Promise<string> {
  const { data: serverIdentity, error: identityError } = await supabase
    .from('user_public_keys')
    .select('fingerprint')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (identityError) {
    throw new Error(`ACCOUNT_IDENTITY_LOOKUP_FAILED:${identityError.message}`);
  }
  const serverFingerprint = String(serverIdentity?.fingerprint ?? '').trim();
  if (serverFingerprint.length >= 32) return serverFingerprint;

  const { data: recoveryVault, error: recoveryVaultError } = await supabase
    .from('aegis_recovery_vaults' as never)
    .select('identity_fingerprint')
    .eq('user_id', userId)
    .maybeSingle();

  if (recoveryVaultError) {
    throw new Error(`ACCOUNT_RECOVERY_VAULT_LOOKUP_FAILED:${recoveryVaultError.message}`);
  }
  const recoveryFingerprint = String(
    (recoveryVault as { identity_fingerprint?: unknown } | null)?.identity_fingerprint ?? '',
  ).trim();
  if (recoveryFingerprint.length >= 32) return recoveryFingerprint;

  const [backupResult, deviceHistoryResult] = await Promise.all([
    supabase
      .from('user_backups' as never)
      .select('id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('user_devices')
      .select('device_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle(),
  ]);

  if (backupResult.error) {
    throw new Error(`ACCOUNT_BACKUP_LOOKUP_FAILED:${backupResult.error.message}`);
  }
  if (deviceHistoryResult.error) {
    throw new Error(`ACCOUNT_DEVICE_HISTORY_LOOKUP_FAILED:${deviceHistoryResult.error.message}`);
  }
  if (backupResult.data || deviceHistoryResult.data?.device_id) {
    throw new Error('ACCOUNT_IDENTITY_BOOTSTRAP_REQUIRES_EXPLICIT_MIGRATION');
  }

  const { getOrCreateIdentityKeys } = await import('@/lib/crypto/keyManagerSafe');
  const localIdentity = await getOrCreateIdentityKeys(userId);
  const localFingerprint = String(localIdentity.fingerprint ?? '').trim();
  if (localFingerprint.length < 32) throw new Error('ACCOUNT_IDENTITY_NOT_FOUND');
  return localFingerprint;
}

export async function beginServerAssignedDeviceEnrollment(
  metadata: DeviceEnrollmentMetadata,
): Promise<DeviceEnrollmentChallenge> {
  const { data, error } = await supabase.rpc(
    'begin_user_device_enrollment' as never,
    {
      p_device_name: metadata.deviceName,
      p_device_fingerprint: metadata.deviceFingerprint,
      p_platform: metadata.platform,
      p_user_agent: metadata.userAgent,
    } as never,
  );

  if (error) throw new Error(`DEVICE_ENROLLMENT_BEGIN_FAILED:${error.message}`);
  return parseDeviceEnrollmentChallenge(data);
}

/** Pending devices cannot approve themselves through the legacy endpoint. */
export async function approveServerAssignedDevice(_deviceId: string): Promise<string> {
  throw new Error('DEVICE_APPROVAL_REQUIRES_TRUSTED_OR_RECOVERED_ACCOUNT');
}

/**
 * Stage the device before restoring account private keys. The candidate proves
 * possession of its own Ed25519 key and binds that proof to the account
 * fingerprint. Authorization is supplied later by another approved device or
 * by a locally restored stable account identity.
 */
export async function completeServerAssignedDeviceEnrollmentCandidate(
  challenge: DeviceEnrollmentChallenge,
  candidate: PendingDeviceCandidate,
): Promise<string> {
  const possessionSignature = await signDeviceEnrollmentPossession({
    challengeId: challenge.challengeId,
    deviceId: challenge.deviceId,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    accountFingerprint: candidate.accountFingerprint,
    devicePublicKey: candidate.deviceKx.publicB64,
    deviceSigningKey: candidate.deviceSigning.publicB64,
    deviceSigningPrivateKey: candidate.deviceSigning.privateKey,
  });

  const { data, error } = await supabase.rpc(
    'complete_user_device_enrollment_candidate' as never,
    {
      p_challenge_id: challenge.challengeId,
      p_nonce: challenge.nonce,
      p_device_public_key: candidate.deviceKx.publicB64,
      p_device_signing_key: candidate.deviceSigning.publicB64,
      p_device_possession_signature: possessionSignature,
      p_account_fingerprint: candidate.accountFingerprint,
    } as never,
  );

  if (error) throw new Error(`DEVICE_ENROLLMENT_COMPLETE_FAILED:${error.message}`);
  return parseCompletedDeviceEnrollment(data, challenge.deviceId);
}

/** Compatibility path for already restored clients. New registrations use the candidate flow above. */
export async function completeServerAssignedDeviceEnrollment(
  challenge: DeviceEnrollmentChallenge,
  authorization: PreparedDeviceAuthorization,
): Promise<string> {
  const possessionSignature = await signDeviceEnrollmentPossession({
    challengeId: challenge.challengeId,
    deviceId: challenge.deviceId,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    accountFingerprint: authorization.account.fingerprint,
    devicePublicKey: authorization.deviceKx.publicB64,
    deviceSigningKey: authorization.deviceSigning.publicB64,
    deviceSigningPrivateKey: authorization.deviceSigning.privateKey,
  });

  const { data, error } = await supabase.rpc(
    'complete_user_device_enrollment' as never,
    {
      p_challenge_id: challenge.challengeId,
      p_nonce: challenge.nonce,
      p_device_public_key: authorization.deviceKx.publicB64,
      p_device_signing_key: authorization.deviceSigning.publicB64,
      p_device_authorization_signature: authorization.authorizationSignature,
      p_device_possession_signature: possessionSignature,
      p_account_identity_key: authorization.account.identityKey,
      p_account_signing_key: authorization.account.signingKey,
      p_account_fingerprint: authorization.account.fingerprint,
      p_account_binding_signature: authorization.account.bindingSignature,
    } as never,
  );

  if (error) throw new Error(`DEVICE_ENROLLMENT_COMPLETE_FAILED:${error.message}`);
  return parseCompletedDeviceEnrollment(data, challenge.deviceId);
}

export async function cancelServerAssignedDeviceEnrollment(
  challenge: DeviceEnrollmentChallenge,
  reason: string,
): Promise<DeviceEnrollmentSettlement> {
  const { data, error } = await supabase.rpc(
    'cancel_user_device_enrollment' as never,
    {
      p_challenge_id: challenge.challengeId,
      p_nonce: challenge.nonce,
      p_reason: reason.slice(0, 120),
    } as never,
  );

  if (error) throw new Error(`DEVICE_ENROLLMENT_CANCEL_FAILED:${error.message}`);
  return parseDeviceEnrollmentSettlement(data, challenge.deviceId);
}
