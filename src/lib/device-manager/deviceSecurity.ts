import { supabase } from '@/integrations/supabase/client';
import {
  beginExplicitDeviceEnrollment,
  getCurrentDeviceLabel,
  getCurrentPlatform,
  getDeviceFingerprint,
  peekCurrentDeviceId,
  setCurrentDeviceId,
  setCurrentDeviceUserScope,
} from '@/lib/messaging/currentDevice';
import {
  beginServerAssignedDeviceEnrollment,
  cancelServerAssignedDeviceEnrollment,
  completeServerAssignedDeviceEnrollment,
  type DeviceEnrollmentChallenge,
  type DevicePlatform,
} from '@/lib/crypto/serverDeviceEnrollment';
import {
  deleteDeviceIdentity,
  getOrCreateDeviceIdentity,
  loadDeviceIdentity,
} from '@/lib/crypto/deviceIdentity';
import {
  deleteDeviceKxKey,
  getOrCreateDeviceKxKey,
  loadDeviceKxKey,
} from '@/lib/crypto/deviceKx';
import {
  submitCurrentDeviceApprovalDecision,
  type DeviceApprovalDecision,
} from '@/lib/crypto/deviceApprovalDecision';
import { bindApprovedDeviceToAccount } from '@/lib/crypto/deviceAccountBinding';
import {
  refreshDeviceSignedPrekeyIfNeeded,
  refillDeviceOneTimePrekeysIfNeeded,
  peekDeviceSignedPrekey,
  isDevicePrekeyBundleError,
} from '@/lib/crypto/x3dh';
import { repairCurrentDevicePrekeys } from '@/lib/crypto/devicePrekeyRepair';
import { ensureApprovedDeviceTrust } from '@/lib/crypto/deviceLinkTrust';
import { invalidateAllFanoutRoutes } from '@/lib/messaging/fanoutRouteCache';
import { invalidateAegisDeviceRuntime } from '@/lib/messaging/aegisDeviceRuntime';

const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

export type DeviceSecurityState =
  | 'unregistered'
  | 'pending_approval'
  | 'approved_locked'
  | 'binding_required'
  | 'key_setup_required'
  | 'ready'
  | 'revoked';

export interface DeviceSecurityRecord {
  deviceId: string;
  approvalStatus: 'pending' | 'approved' | 'rejected' | null;
  bindingStatus: 'pending' | 'bound' | 'revoked' | null;
  routingStatus: 'repairing' | 'ready' | 'unavailable' | null;
  isActive: boolean;
  revokedAt: string | null;
  deviceName: string | null;
  platform: string | null;
  devicePublicKey: string | null;
  deviceSigningKey: string | null;
  approvalChallengeId: string | null;
}

export interface DeviceSecuritySnapshot {
  state: DeviceSecurityState;
  record: DeviceSecurityRecord | null;
}

function normalizePlatform(value: unknown): DevicePlatform {
  const platform = String(value ?? '').toLowerCase();
  return platform === 'ios' || platform === 'android' ? platform : 'web';
}

function stateFromRecord(record: DeviceSecurityRecord | null): DeviceSecurityState {
  if (!record) return 'unregistered';
  if (record.revokedAt || record.approvalStatus === 'rejected' || record.bindingStatus === 'revoked') return 'revoked';
  if (record.approvalStatus !== 'approved') return 'pending_approval';
  if (!record.isActive) return 'revoked';
  if (record.bindingStatus !== 'bound') return 'binding_required';
  if (record.routingStatus !== 'ready') return 'key_setup_required';
  return 'ready';
}

async function readDeviceRecord(userId: string, deviceId: string): Promise<DeviceSecurityRecord | null> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('device_id,approval_status,binding_status,routing_status,is_active,revoked_at,device_name,platform,device_public_key,device_signing_key,approval_challenge_id')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();

  if (error) throw new Error(`DEVICE_SECURITY_LOOKUP_FAILED:${error.message}`);
  if (!data) return null;

  return {
    deviceId: data.device_id,
    approvalStatus: data.approval_status as DeviceSecurityRecord['approvalStatus'],
    bindingStatus: data.binding_status as DeviceSecurityRecord['bindingStatus'],
    routingStatus: data.routing_status as DeviceSecurityRecord['routingStatus'],
    isActive: data.is_active === true,
    revokedAt: data.revoked_at ?? null,
    deviceName: data.device_name ?? null,
    platform: data.platform ?? null,
    devicePublicKey: data.device_public_key ?? null,
    deviceSigningKey: data.device_signing_key ?? null,
    approvalChallengeId: data.approval_challenge_id ?? null,
  };
}

export async function getDeviceSecurityState(userId: string): Promise<DeviceSecuritySnapshot> {
  setCurrentDeviceUserScope(userId);
  const deviceId = peekCurrentDeviceId();
  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) return { state: 'unregistered', record: null };
  const record = await readDeviceRecord(userId, deviceId);
  return { state: stateFromRecord(record), record };
}

export async function enrollCurrentDevice(userId: string): Promise<DeviceSecurityRecord> {
  setCurrentDeviceUserScope(userId);
  await beginExplicitDeviceEnrollment('user_requested_new_device');

  let challenge: DeviceEnrollmentChallenge | null = null;
  let deviceId: string | null = null;
  try {
    challenge = await beginServerAssignedDeviceEnrollment({
      deviceName: getCurrentDeviceLabel(),
      deviceFingerprint: await getDeviceFingerprint(),
      platform: normalizePlatform(getCurrentPlatform()),
      userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent.slice(0, 500),
    });

    deviceId = setCurrentDeviceId(challenge.deviceId);
    const [identity, kx] = await Promise.all([
      getOrCreateDeviceIdentity(userId, deviceId),
      getOrCreateDeviceKxKey(deviceId, userId),
    ]);

    await completeServerAssignedDeviceEnrollment(challenge, identity, kx);
    challenge = null;

    const record = await readDeviceRecord(userId, deviceId);
    if (!record || record.approvalStatus !== 'pending') throw new Error('DEVICE_ENROLLMENT_NOT_PENDING');
    return record;
  } catch (error) {
    if (challenge) {
      await cancelServerAssignedDeviceEnrollment(
        challenge,
        error instanceof Error ? error.message.slice(0, 120) : 'DEVICE_ENROLLMENT_FAILED',
      ).catch(() => undefined);
    }
    if (deviceId) {
      await Promise.allSettled([
        deleteDeviceIdentity(userId, deviceId),
        deleteDeviceKxKey(deviceId, userId),
      ]);
    }
    throw error;
  }
}

export async function decideCurrentDeviceApproval(
  userId: string,
  decision: DeviceApprovalDecision,
): Promise<DeviceSecurityRecord> {
  const snapshot = await getDeviceSecurityState(userId);
  const record = snapshot.record;
  if (!record || record.approvalStatus !== 'pending' || !record.approvalChallengeId) {
    throw new Error('DEVICE_APPROVAL_NOT_PENDING');
  }
  if (!record.devicePublicKey || !record.deviceSigningKey) throw new Error('DEVICE_PUBLIC_KEYS_MISSING');

  await submitCurrentDeviceApprovalDecision({
    userId,
    target: {
      deviceId: record.deviceId,
      challengeId: record.approvalChallengeId,
      devicePublicKey: record.devicePublicKey,
      deviceSigningKey: record.deviceSigningKey,
    },
    decision,
  });

  const updated = await readDeviceRecord(userId, record.deviceId);
  if (!updated) throw new Error('DEVICE_APPROVAL_RESULT_MISSING');
  return updated;
}

export async function bindCurrentDeviceToAccount(userId: string): Promise<DeviceSecurityRecord> {
  const snapshot = await getDeviceSecurityState(userId);
  const record = snapshot.record;
  if (!record) throw new Error('DEVICE_NOT_FOUND');
  if (record.approvalStatus !== 'approved' || !record.isActive || record.revokedAt) {
    throw new Error('DEVICE_NOT_APPROVED');
  }

  await bindApprovedDeviceToAccount(userId, record.deviceId);
  const updated = await readDeviceRecord(userId, record.deviceId);
  if (!updated || updated.bindingStatus !== 'bound') throw new Error('DEVICE_ACCOUNT_BINDING_FAILED');
  return updated;
}

export async function prepareCurrentDeviceKeys(userId: string): Promise<DeviceSecurityRecord> {
  const snapshot = await getDeviceSecurityState(userId);
  const record = snapshot.record;
  if (!record) throw new Error('DEVICE_NOT_FOUND');
  if (record.approvalStatus !== 'approved' || !record.isActive || record.bindingStatus !== 'bound' || record.revokedAt) {
    throw new Error('DEVICE_NOT_READY_FOR_KEYS');
  }

  const [identity, kx] = await Promise.all([
    loadDeviceIdentity(userId, record.deviceId),
    loadDeviceKxKey(record.deviceId, userId),
  ]);
  if (!identity || !kx) throw new Error('DEVICE_LOCAL_PRIVATE_KEYS_MISSING');
  if (identity.publicB64 !== record.deviceSigningKey || kx.publicB64 !== record.devicePublicKey) {
    throw new Error('DEVICE_LOCAL_KEY_MISMATCH');
  }

  try {
    await refreshDeviceSignedPrekeyIfNeeded(userId, record.deviceId, identity.privateKey);
    if (!await peekDeviceSignedPrekey(userId, record.deviceId)) {
      await repairCurrentDevicePrekeys(userId, record.deviceId, identity.privateKey, 'device-key-setup');
    }
  } catch (error) {
    if (!isDevicePrekeyBundleError(error, 'DEVICE_SPK_SIGNATURE_INVALID')) throw error;
    await repairCurrentDevicePrekeys(userId, record.deviceId, identity.privateKey, 'device-spk-signature-invalid');
  }

  await refillDeviceOneTimePrekeysIfNeeded(userId, record.deviceId);

  const { data, error } = await supabase.rpc('mark_current_device_route_ready' as never, {
    p_device_id: record.deviceId,
  } as never);
  const route = data as { ok?: boolean; code?: string } | null;
  if (error || route?.ok !== true) {
    throw new Error(`DEVICE_ROUTE_NOT_READY:${route?.code ?? error?.message ?? 'UNKNOWN'}`);
  }

  invalidateAllFanoutRoutes();
  invalidateAegisDeviceRuntime(userId);
  await ensureApprovedDeviceTrust(userId, record.deviceId);

  const updated = await readDeviceRecord(userId, record.deviceId);
  if (!updated || updated.routingStatus !== 'ready') throw new Error('DEVICE_KEY_SETUP_INCOMPLETE');
  return updated;
}

export const deviceSecurity = {
  getState: getDeviceSecurityState,
  enroll: enrollCurrentDevice,
  approve: (userId: string) => decideCurrentDeviceApproval(userId, 'approve'),
  reject: (userId: string) => decideCurrentDeviceApproval(userId, 'reject'),
  bind: bindCurrentDeviceToAccount,
  prepareKeys: prepareCurrentDeviceKeys,
} as const;
