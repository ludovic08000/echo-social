import { supabase } from '@/integrations/supabase/client';
import { signDeviceEnrollmentPossession } from '@/lib/crypto/deviceEnrollmentPossession';
import { consumeExplicitDeviceEnrollmentAuthorization } from '@/lib/crypto/deviceEnrollmentGate';
import { getCurrentPlatform } from '@/lib/messaging/currentDevice';
import type { DeviceIdentityKey } from '@/lib/crypto/deviceIdentity';
import type { DeviceKxKey } from '@/lib/crypto/deviceKx';

const SERVER_DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RpcObject = Record<string, unknown>;
export type DevicePlatform = 'ios' | 'android' | 'web';

type RegisteredDeviceRow = {
  device_id: string;
  platform: string | null;
  is_active: boolean | null;
  approval_status: string | null;
  revoked_at: string | null;
  crypto_invalid_at: string | null;
  binding_status: string | null;
};

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

export type DeviceEnrollmentSettlement = { status: 'completed' | 'cancelled'; deviceId: string };

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
  return platform === 'ios' || platform === 'android' ? platform : 'web';
}

export function isRegisteredDeviceReusable(
  serverPlatform: unknown,
  runtimePlatform: unknown,
  state?: RegisteredDeviceReuseState,
): boolean {
  if (state) {
    const approvalStatus = String(state.approvalStatus ?? '').toLowerCase();
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
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) throw new Error('DEVICE_ENROLLMENT_INVALID_EXPIRY');
  if (Date.parse(expiresAt) <= Date.now()) throw new Error('DEVICE_ENROLLMENT_EXPIRED');
  return { challengeId, deviceId, nonce, expiresAt };
}

export function parseCompletedDeviceEnrollment(value: unknown, expectedDeviceId: string): string {
  const result = asObject(value);
  if (result.ok !== true) throw new Error(responseCode(result));
  if (responseCode(result) !== 'DEVICE_ENROLLMENT_STAGED') {
    throw new Error('DEVICE_ENROLLMENT_NOT_STAGED');
  }
  const deviceId = typeof result.device_id === 'string' ? result.device_id : '';
  if (!SERVER_DEVICE_ID_RE.test(deviceId)) throw new Error('DEVICE_ENROLLMENT_INVALID_DEVICE_ID');
  if (deviceId !== expectedDeviceId) throw new Error('DEVICE_ENROLLMENT_SERVER_ID_MISMATCH');
  return deviceId;
}

export function parseDeviceEnrollmentSettlement(value: unknown, expectedDeviceId: string): DeviceEnrollmentSettlement {
  const result = asObject(value);
  if (result.ok !== true) throw new Error(responseCode(result));
  const deviceId = typeof result.device_id === 'string' ? result.device_id : '';
  if (!SERVER_DEVICE_ID_RE.test(deviceId)) throw new Error('DEVICE_ENROLLMENT_INVALID_DEVICE_ID');
  if (deviceId !== expectedDeviceId) throw new Error('DEVICE_ENROLLMENT_SERVER_ID_MISMATCH');
  const code = responseCode(result);
  if (code === 'DEVICE_ENROLLMENT_ALREADY_COMPLETED') return { status: 'completed', deviceId };
  if (code === 'DEVICE_ENROLLMENT_CANCELLED' || code === 'DEVICE_ENROLLMENT_ALREADY_CANCELLED') {
    return { status: 'cancelled', deviceId };
  }
  throw new Error('DEVICE_ENROLLMENT_INVALID_SETTLEMENT');
}

export async function hasRegisteredDevice(userId: string, deviceId: string): Promise<boolean> {
  if (!deviceId) return false;
  const { data, error } = await supabase
    .from('user_devices')
    .select('*')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();
  if (error) throw new Error(`DEVICE_ROUTE_LOOKUP_FAILED:${error.message}`);
  if (!data) return false;
  const row = data as unknown as RegisteredDeviceRow;
  if (!row.device_id || row.binding_status !== 'bound') return false;
  return isRegisteredDeviceReusable(row.platform, getCurrentPlatform(), {
    isActive: row.is_active,
    approvalStatus: row.approval_status,
    revokedAt: row.revoked_at,
    cryptoInvalidAt: row.crypto_invalid_at,
  });
}

export async function beginServerAssignedDeviceEnrollment(
  metadata: DeviceEnrollmentMetadata,
): Promise<DeviceEnrollmentChallenge> {
  consumeExplicitDeviceEnrollmentAuthorization();
  const { data, error } = await supabase.rpc('begin_user_device_enrollment' as never, {
    p_device_name: metadata.deviceName,
    p_device_fingerprint: metadata.deviceFingerprint,
    p_platform: metadata.platform,
    p_user_agent: metadata.userAgent,
  } as never);
  if (error) throw new Error(`DEVICE_ENROLLMENT_BEGIN_FAILED:${error.message}`);
  return parseDeviceEnrollmentChallenge(data);
}

export async function completeServerAssignedDeviceEnrollment(
  challenge: DeviceEnrollmentChallenge,
  deviceIdentity: DeviceIdentityKey,
  deviceKx: DeviceKxKey,
): Promise<string> {
  const possessionSignature = await signDeviceEnrollmentPossession({
    challengeId: challenge.challengeId,
    deviceId: challenge.deviceId,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    devicePublicKey: deviceKx.publicB64,
    deviceSigningKey: deviceIdentity.publicB64,
    deviceSigningPrivateKey: deviceIdentity.privateKey,
  });

  const { data, error } = await supabase.rpc('complete_user_device_enrollment' as never, {
    p_challenge_id: challenge.challengeId,
    p_nonce: challenge.nonce,
    p_device_public_key: deviceKx.publicB64,
    p_device_signing_key: deviceIdentity.publicB64,
    p_device_possession_signature: possessionSignature,
  } as never);
  if (error) throw new Error(`DEVICE_ENROLLMENT_COMPLETE_FAILED:${error.message}`);
  return parseCompletedDeviceEnrollment(data, challenge.deviceId);
}

export async function cancelServerAssignedDeviceEnrollment(
  challenge: DeviceEnrollmentChallenge,
  reason: string,
): Promise<DeviceEnrollmentSettlement> {
  const { data, error } = await supabase.rpc('cancel_user_device_enrollment' as never, {
    p_challenge_id: challenge.challengeId,
    p_nonce: challenge.nonce,
    p_reason: reason.slice(0, 120),
  } as never);
  if (error) throw new Error(`DEVICE_ENROLLMENT_CANCEL_FAILED:${error.message}`);
  return parseDeviceEnrollmentSettlement(data, challenge.deviceId);
}
