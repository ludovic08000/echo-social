import { supabase } from '@/integrations/supabase/client';
import {
  backupIosDeviceVaultIfReady,
  ensureIosDeviceVaultRestored,
} from '@/platforms/ios/iosDeviceVaultRestore';

import {
  beginExplicitDeviceEnrollment,
  getCurrentDeviceLabel,
  getCurrentPlatform,
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
  submitTrustedDeviceApprovalDecision,
  submitPrimaryBootstrapDecision,
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
import { invalidateDeviceSession } from '@/lib/crypto/deviceRatchet';
import {
  adoptExistingIosDevice,
  adoptReusableIosDevice,
  resolveExistingIosDevice,
} from '@/platforms/ios/iosDeviceReuse';
import { recordIosRpcError } from '@/platforms/ios/iosRpcErrorLog';
import { adoptReusableAndroidDevice, resolveExistingAndroidDevice } from '@/platforms/android/androidDeviceReuse';
import { backupAndroidDeviceVault, restoreAndroidDeviceVault } from '@/platforms/android/androidDeviceVault';

const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

export type DeviceApiState =
  | 'unregistered'
  | 'pending_approval'
  | 'binding_required'
  | 'key_setup_required'
  | 'ready'
  | 'revoked';

export interface DeviceApiRecord {
  deviceId: string;
  deviceRole: 'primary' | 'secondary' | null;
  lifecycleStatus: 'pending' | 'approved' | 'syncing' | 'ready' | 'revoked' | null;
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
  approvedByDeviceId: string | null;
}

export interface DeviceApiListRecord extends DeviceApiRecord {
  id: string;
  userAgent: string | null;
  approvalRequestedAt: string | null;
  lastSeenAt: string;
  createdAt: string;
  staleAt: string | null;
  revokeReason: string | null;
}

export interface DeviceApiSnapshot {
  state: DeviceApiState;
  record: DeviceApiRecord | null;
}

type DeviceDbRow = {
  id?: string;
  device_id: string;
  device_role?: string | null;
  lifecycle_status?: string | null;
  approval_status: string | null;
  binding_status: string | null;
  routing_status: string | null;
  is_active: boolean | null;
  revoked_at: string | null;
  device_name: string | null;
  platform: string | null;
  device_public_key: string | null;
  device_signing_key: string | null;
  approval_challenge_id: string | null;
  approved_by_device_id?: string | null;
  approval_requested_at?: string | null;
  user_agent?: string | null;
  last_seen_at?: string | null;
  created_at?: string | null;
  stale_at?: string | null;
  revoke_reason?: string | null;
};

function normalizePlatform(value: unknown): DevicePlatform {
  const platform = String(value ?? '').toLowerCase();
  return platform === 'ios' || platform === 'android' ? platform : 'web';
}

function stateFromRecord(record: DeviceApiRecord | null): DeviceApiState {
  if (!record) return 'unregistered';
  if (record.revokedAt || record.lifecycleStatus === 'revoked' || record.approvalStatus === 'rejected' || record.bindingStatus === 'revoked') return 'revoked';
  if (record.approvalStatus !== 'approved') return 'pending_approval';
  if (!record.isActive) return 'revoked';
  if (record.bindingStatus !== 'bound') return 'binding_required';
  if (record.routingStatus !== 'ready' || record.lifecycleStatus !== 'ready') return 'key_setup_required';
  return 'ready';
}

function mapDbRecord(row: DeviceDbRow): DeviceApiRecord {
  return {
    deviceId: row.device_id,
    deviceRole: row.device_role as DeviceApiRecord['deviceRole'] ?? null,
    lifecycleStatus: row.lifecycle_status as DeviceApiRecord['lifecycleStatus'] ?? null,
    approvalStatus: row.approval_status as DeviceApiRecord['approvalStatus'],
    bindingStatus: row.binding_status as DeviceApiRecord['bindingStatus'],
    routingStatus: row.routing_status as DeviceApiRecord['routingStatus'],
    isActive: row.is_active === true,
    revokedAt: row.revoked_at ?? null,
    deviceName: row.device_name ?? null,
    platform: row.platform ?? null,
    devicePublicKey: row.device_public_key ?? null,
    deviceSigningKey: row.device_signing_key ?? null,
    approvalChallengeId: row.approval_challenge_id ?? null,
    approvedByDeviceId: row.approved_by_device_id ?? null,
  };
}

async function readDeviceRecord(userId: string, deviceId: string): Promise<DeviceApiRecord | null> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('*')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();
  if (error) throw new Error(`DEVICE_LOOKUP_FAILED:${error.message}`);
  if (!data) return null;
  return mapDbRecord(data as unknown as DeviceDbRow);
}

async function getState(userId: string): Promise<DeviceApiSnapshot> {
  setCurrentDeviceUserScope(userId);
  const deviceId = peekCurrentDeviceId();
  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) return { state: 'unregistered', record: null };
  const record = await readDeviceRecord(userId, deviceId);
  return { state: stateFromRecord(record), record };
}

function getCurrentId(userId: string): string | null {
  setCurrentDeviceUserScope(userId);
  const deviceId = peekCurrentDeviceId();
  return deviceId && DEVICE_ID_RE.test(deviceId) ? deviceId : null;
}

async function listDevices(userId: string): Promise<DeviceApiListRecord[]> {
  setCurrentDeviceUserScope(userId);
  const { data, error } = await supabase
    .from('user_devices')
    .select('*')
    .eq('user_id', userId)
    .order('last_seen_at', { ascending: false });
  if (error) throw new Error(`DEVICE_LIST_FAILED:${error.message}`);

  return (data ?? []).map((raw) => {
    const row = raw as unknown as DeviceDbRow;
    return {
      ...mapDbRecord(row),
      id: row.id ?? row.device_id,
      userAgent: row.user_agent ?? null,
      approvalRequestedAt: row.approval_requested_at ?? null,
      lastSeenAt: row.last_seen_at ?? row.created_at ?? new Date(0).toISOString(),
      createdAt: row.created_at ?? new Date(0).toISOString(),
      staleAt: row.stale_at ?? null,
      revokeReason: row.revoke_reason ?? null,
    };
  });
}

async function enroll(userId: string): Promise<DeviceApiRecord> {
  setCurrentDeviceUserScope(userId);

  const reusedAndroidDeviceId = await adoptReusableAndroidDevice(userId).catch(() => null);
  if (reusedAndroidDeviceId) {
    const existing = await readDeviceRecord(userId, reusedAndroidDeviceId);
    if (existing && !existing.revokedAt && existing.approvalStatus !== 'rejected') return existing;
  }

  const existingAndroidDeviceId = await resolveExistingAndroidDevice(userId);
  if (existingAndroidDeviceId) {
    setCurrentDeviceId(existingAndroidDeviceId);
    if (await restoreAndroidDeviceVault(userId)) {
      const existing = await readDeviceRecord(userId, existingAndroidDeviceId);
      if (existing && !existing.revokedAt && existing.approvalStatus !== 'rejected') return existing;
    }
    throw new Error(`DEVICE_VAULT_RECOVERY_REQUIRED:${existingAndroidDeviceId}:android`);
  }

  // iOS uniquement : aucun nouveau device si une identité locale existe déjà
  // (Keychain/Secure Enclave). No-op complet sur Windows/web.
  const reusedDeviceId = await adoptReusableIosDevice(userId).catch((error) => {
    recordIosRpcError('ios.enroll.reuse', error);
    return null;
  });
  if (reusedDeviceId) {
    const existing = await readDeviceRecord(userId, reusedDeviceId);
    if (existing && !existing.revokedAt && existing.approvalStatus !== 'rejected') return existing;
  }

  // A Keychain/current DeviceID without locally readable keys is continuity
  // evidence, not permission to allocate another server device. Restore the
  // exact vault first; otherwise surface the recovery flow explicitly.
  const existingIosDevice = await resolveExistingIosDevice(userId);
  if (existingIosDevice) {
    adoptExistingIosDevice(existingIosDevice);
    const restored = await ensureIosDeviceVaultRestored(userId);
    if (restored === 'restored' || restored === 'not_needed') {
      const reusableAfterRestore = await adoptReusableIosDevice(userId);
      if (reusableAfterRestore) {
        const existing = await readDeviceRecord(userId, reusableAfterRestore);
        if (existing && !existing.revokedAt && existing.approvalStatus !== 'rejected') return existing;
      }
    }
    throw new Error(`DEVICE_VAULT_RECOVERY_REQUIRED:${existingIosDevice.deviceId}:${restored}`);
  }

  await beginExplicitDeviceEnrollment('user_requested_new_device');
  let challenge: DeviceEnrollmentChallenge | null = null;
  let deviceId: string | null = null;
  try {
    challenge = await beginServerAssignedDeviceEnrollment({
      deviceName: getCurrentDeviceLabel(),
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

async function decide(userId: string, targetDeviceId: string, decision: DeviceApprovalDecision): Promise<DeviceApiRecord> {
  const approverDeviceId = getCurrentId(userId);
  if (!approverDeviceId) throw new Error('DEVICE_APPROVER_REQUIRED');
  if (approverDeviceId === targetDeviceId) throw new Error('DEVICE_SELF_APPROVAL_FORBIDDEN');
  const approver = await readDeviceRecord(userId, approverDeviceId);
  if (!approver || approver.lifecycleStatus !== 'ready' || approver.approvalStatus !== 'approved' || !approver.isActive || approver.revokedAt) {
    throw new Error('APPROVER_DEVICE_NOT_READY');
  }
  const record = await readDeviceRecord(userId, targetDeviceId);
  if (!record || record.approvalStatus !== 'pending' || !record.approvalChallengeId) throw new Error('DEVICE_APPROVAL_NOT_PENDING');
  if (!record.devicePublicKey || !record.deviceSigningKey) throw new Error('DEVICE_PUBLIC_KEYS_MISSING');
  await submitTrustedDeviceApprovalDecision({
    userId,
    approverDeviceId,
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

async function bootstrapPrimary(userId: string): Promise<DeviceApiRecord> {
  const snapshot = await getState(userId);
  const record = snapshot.record;
  if (!record || record.approvalStatus !== 'pending' || !record.approvalChallengeId
      || !record.devicePublicKey || !record.deviceSigningKey) {
    throw new Error('DEVICE_BOOTSTRAP_NOT_PENDING');
  }

  const { data: modeData, error: modeError } = await supabase.rpc(
    'get_device_enrollment_approval_mode' as never,
    { p_device_id: record.deviceId } as never,
  );
  const mode = modeData as { ok?: boolean; bootstrap_primary?: boolean; code?: string } | null;
  if (modeError) throw new Error(`DEVICE_BOOTSTRAP_MODE_FAILED:${modeError.message}`);
  if (mode?.ok === false) throw new Error(`DEVICE_BOOTSTRAP_MODE_REJECTED:${mode.code ?? 'UNKNOWN'}`);
  if (mode?.bootstrap_primary !== true) throw new Error('DEVICE_BOOTSTRAP_FORBIDDEN_TRUSTED_APPROVER_REQUIRED');

  await submitPrimaryBootstrapDecision({
    userId,
    target: {
      deviceId: record.deviceId,
      challengeId: record.approvalChallengeId,
      devicePublicKey: record.devicePublicKey,
      deviceSigningKey: record.deviceSigningKey,
    },
  });
  const updated = await readDeviceRecord(userId, record.deviceId);
  if (!updated || updated.deviceRole !== 'primary') throw new Error('DEVICE_BOOTSTRAP_RESULT_INVALID');
  return updated;
}

async function bind(userId: string): Promise<DeviceApiRecord> {
  const snapshot = await getState(userId);
  const record = snapshot.record;
  if (!record) throw new Error('DEVICE_NOT_FOUND');
  if (record.approvalStatus !== 'approved' || !record.isActive || record.revokedAt) throw new Error('DEVICE_NOT_APPROVED');
  await bindApprovedDeviceToAccount(userId, record.deviceId);
  const updated = await readDeviceRecord(userId, record.deviceId);
  if (!updated || updated.bindingStatus !== 'bound') throw new Error('DEVICE_ACCOUNT_BINDING_FAILED');
  return updated;
}

async function prepareKeys(userId: string): Promise<DeviceApiRecord> {
  const snapshot = await getState(userId);
  const record = snapshot.record;
  if (!record) throw new Error('DEVICE_NOT_FOUND');
  if (record.approvalStatus !== 'approved' || !record.isActive || record.bindingStatus !== 'bound' || record.revokedAt) {
    throw new Error('DEVICE_NOT_READY_FOR_KEYS');
  }
  let [identity, kx] = await Promise.all([
    loadDeviceIdentity(userId, record.deviceId),
    loadDeviceKxKey(record.deviceId, userId),
  ]);
  if (!identity || !kx) {
    // iOS Web : Safari peut purger l'IndexedDB. On restaure le coffre scellé
    // du MÊME DeviceID déjà approuvé, sans jamais en créer un nouveau.
    const restored = await ensureIosDeviceVaultRestored(userId);
    if (restored === 'restored') {
      [identity, kx] = await Promise.all([
        loadDeviceIdentity(userId, record.deviceId),
        loadDeviceKxKey(record.deviceId, userId),
      ]);
    }
    if ((!identity || !kx) && await restoreAndroidDeviceVault(userId)) {
      [identity, kx] = await Promise.all([
        loadDeviceIdentity(userId, record.deviceId),
        loadDeviceKxKey(record.deviceId, userId),
      ]);
    }
  }
  if (!identity || !kx) throw new Error('DEVICE_LOCAL_PRIVATE_KEYS_MISSING');
  if (identity.publicB64 !== record.deviceSigningKey || kx.publicB64 !== record.devicePublicKey) throw new Error('DEVICE_LOCAL_KEY_MISMATCH');
  void backupIosDeviceVaultIfReady(userId);
  void backupAndroidDeviceVault(userId);

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
  // iOS becomes routable only after the exact private X3DH material has been
  // sealed, uploaded and read back successfully for this DeviceID.
  const { isIosWebRuntime } = await import('@/platforms/ios/iosRuntime');
  if (isIosWebRuntime() && !await backupIosDeviceVaultIfReady(userId)) {
    throw new Error('DEVICE_X3DH_VAULT_BACKUP_REQUIRED');
  }
  const { isAndroidRuntime } = await import('@/platforms/android/androidRuntime');
  if (isAndroidRuntime() && !await backupAndroidDeviceVault(userId)) {
    throw new Error('DEVICE_X3DH_VAULT_BACKUP_REQUIRED');
  }
  const { data, error } = await supabase.rpc('mark_current_device_route_ready' as never, { p_device_id: record.deviceId } as never);
  const route = data as { ok?: boolean; code?: string } | null;
  if (error || route?.ok !== true) throw new Error(`DEVICE_ROUTE_NOT_READY:${route?.code ?? error?.message ?? 'UNKNOWN'}`);
  const { data: syncData, error: syncError } = await supabase.rpc('complete_current_device_synchronization' as never, {
    p_device_id: record.deviceId,
  } as never);
  const syncResult = syncData as { ok?: boolean; code?: string } | null;
  if (syncError || syncResult?.ok !== true) {
    throw new Error(`DEVICE_SYNCHRONIZATION_INCOMPLETE:${syncResult?.code ?? syncError?.message ?? 'UNKNOWN'}`);
  }
  invalidateAllFanoutRoutes();
  invalidateAegisDeviceRuntime(userId);
  await ensureApprovedDeviceTrust(userId, record.deviceId);
  const updated = await readDeviceRecord(userId, record.deviceId);
  if (!updated || updated.routingStatus !== 'ready' || updated.lifecycleStatus !== 'ready') throw new Error('DEVICE_KEY_SETUP_INCOMPLETE');
  return updated;
}

async function revokeDevice(userId: string, targetDeviceId: string): Promise<void> {
  if (!DEVICE_ID_RE.test(targetDeviceId)) throw new Error('DEVICE_INVALID_ID');
  const currentDeviceId = getCurrentId(userId);
  if (!currentDeviceId) throw new Error('DEVICE_CURRENT_ID_REQUIRED');
  if (targetDeviceId === currentDeviceId) throw new Error('DEVICE_CANNOT_REVOKE_CURRENT');

  const { data, error } = await supabase.rpc('revoke_user_device' as never, {
    p_device_id: targetDeviceId,
  } as never);
  const result = data as { ok?: boolean } | null;
  if (error || result?.ok !== true) throw new Error(`DEVICE_REVOCATION_REJECTED:${error?.message ?? 'UNKNOWN'}`);

  invalidateAllFanoutRoutes();
  invalidateAegisDeviceRuntime(userId);
  await invalidateDeviceSession(userId, currentDeviceId, userId, targetDeviceId).catch(() => undefined);
}

/**
 * Trace diagnostique iOS : capture l'erreur pour le panneau « Appareil
 * connecté » puis la relance telle quelle. Le comportement (y compris Windows)
 * est strictement inchangé.
 */
async function withIosDiagnostics<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    recordIosRpcError(operation, error);
    throw error;
  }
}

export const deviceApi = {
  getState,
  getCurrentId,
  listDevices,
  enroll: (userId: string) => withIosDiagnostics('deviceApi.enroll', () => enroll(userId)),
  bootstrapPrimary,
  approve: (userId: string, targetDeviceId: string) => decide(userId, targetDeviceId, 'approve'),
  reject: (userId: string, targetDeviceId: string) => decide(userId, targetDeviceId, 'reject'),
  bind: (userId: string) => withIosDiagnostics('deviceApi.bind', () => bind(userId)),
  prepareKeys: (userId: string) => withIosDiagnostics('deviceApi.prepareKeys', () => prepareKeys(userId)),
  revokeDevice,
} as const;

