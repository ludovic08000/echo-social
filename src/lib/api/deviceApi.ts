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
import { submitAutomaticDeviceApproval } from '@/lib/crypto/deviceApprovalDecision';
import { bindApprovedDeviceToAccount } from '@/lib/crypto/deviceAccountBinding';
import { provisionLibsignalDevice } from '@/lib/crypto/libsignalProvisioning';
import {
  refillDeviceOneTimePrekeysIfNeeded,
  refreshDeviceSignedPrekeyIfNeeded,
} from '@/lib/crypto/x3dh';
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
import { runDeviceRpcWithTimeout } from '@/lib/api/deviceRpcTimeout';
import {
  startFinalizationTimer,
  traceCurrentDeviceFinalization,
} from '@/lib/device-manager/deviceFinalizationTrace';
import { adoptReusableAndroidDevice, resolveExistingAndroidDevice } from '@/platforms/android/androidDeviceReuse';
import { backupAndroidDeviceVault, restoreAndroidDeviceVault } from '@/platforms/android/androidDeviceVault';

const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

// Invariant cryptographique : toutes les vues partagent la même transition
// active par compte. Aucun binding ni lot de préclés ne peut être publié deux fois.
const bindInFlight = new Map<string, Promise<DeviceApiRecord>>();
const keySetupInFlight = new Map<string, Promise<DeviceApiRecord>>();

function runDeviceTransitionOnce(
  transitions: Map<string, Promise<DeviceApiRecord>>,
  userId: string,
  run: () => Promise<DeviceApiRecord>,
): Promise<DeviceApiRecord> {
  const active = transitions.get(userId);
  if (active) return active;

  const transition = run().finally(() => {
    if (transitions.get(userId) === transition) transitions.delete(userId);
  });
  transitions.set(userId, transition);
  return transition;
}

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

/**
 * Invariant cryptographique modifié : plus aucune approbation manuelle par un
 * autre appareil. L'appareil courant demande son approbation au serveur, qui
 * vérifie l'utilisateur authentifié, la propriété du device et les signatures
 * avant de persister `approved`. Fail-closed sur toute erreur serveur.
 */
async function autoApprove(userId: string): Promise<DeviceApiRecord> {
  const snapshot = await getState(userId);
  const record = snapshot.record;
  if (!record) throw new Error('DEVICE_NOT_FOUND');
  if (record.revokedAt || record.approvalStatus === 'rejected') throw new Error('DEVICE_REVOKED');
  if (record.approvalStatus === 'approved') return record;
  if (record.approvalStatus !== 'pending' || !record.approvalChallengeId
      || !record.devicePublicKey || !record.deviceSigningKey) {
    throw new Error('DEVICE_AUTO_APPROVAL_NOT_PENDING');
  }

  await submitAutomaticDeviceApproval({
    userId,
    target: {
      deviceId: record.deviceId,
      challengeId: record.approvalChallengeId,
      devicePublicKey: record.devicePublicKey,
      deviceSigningKey: record.deviceSigningKey,
    },
  });

  const updated = await readDeviceRecord(userId, record.deviceId);
  if (!updated || updated.approvalStatus !== 'approved' || !updated.isActive) {
    throw new Error('DEVICE_AUTO_APPROVAL_RESULT_INVALID');
  }
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
  const elapsed = startFinalizationTimer();
  const snapshot = await getState(userId);
  const record = snapshot.record;
  traceCurrentDeviceFinalization({
    step: 'device_api.prepare_keys.route_state_before',
    outcome: 'info',
    elapsedMs: elapsed(),
    userId,
    deviceId: record?.deviceId ?? null,
    state: record ? {
      approvalStatus: record.approvalStatus,
      bindingStatus: record.bindingStatus,
      routingStatus: record.routingStatus,
      lifecycleStatus: record.lifecycleStatus,
      isActive: record.isActive,
      revoked: Boolean(record.revokedAt),
    } : null,
  });
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

  await provisionLibsignalDevice(userId, record.deviceId);
  // Invariant corrigé : `mark_current_device_route_ready` exige côté serveur une
  // `device_signed_prekeys` active, non expirée et vérifiable. Personne ne la
  // publiait, donc la route restait DEVICE_ROUTE_INCOMPLETE et l'écran
  // « Finalisation de cet appareil » tournait sans fin. Elle est désormais
  // publiée ici, avant la validation serveur.
  await refreshDeviceSignedPrekeyIfNeeded(userId, record.deviceId, identity.privateKey);
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
  const rpcElapsed = startFinalizationTimer();
  traceCurrentDeviceFinalization({
    step: 'rpc.mark_current_device_route_ready',
    outcome: 'start',
    userId,
    deviceId: record.deviceId,
  });
  const { data, error } = await runDeviceRpcWithTimeout(
    'DEVICE_ROUTE_NOT_READY',
    (signal) => supabase
      .rpc('mark_current_device_route_ready' as never, { p_device_id: record.deviceId } as never)
      .abortSignal(signal),
  );
  const route = data as { ok?: boolean; code?: string } | null;
  traceCurrentDeviceFinalization({
    step: 'rpc.mark_current_device_route_ready',
    outcome: !error && route?.ok === true ? 'success' : 'failure',
    elapsedMs: rpcElapsed(),
    userId,
    deviceId: record.deviceId,
    detail: route?.code ?? (error ? 'rpc_error' : 'no_code'),
    errorCode: !error && route?.ok === true ? undefined : 'DEVICE_ROUTE_NOT_READY',
  });
  if (error || route?.ok !== true) throw new Error(`DEVICE_ROUTE_NOT_READY:${route?.code ?? error?.message ?? 'UNKNOWN'}`);
  invalidateAllFanoutRoutes();
  invalidateAegisDeviceRuntime(userId);
  // Maintenance non bloquante : le pool de préclés à usage unique se remplit en
  // arrière-plan, l'interface ne doit jamais l'attendre pour devenir prête.
  void refillDeviceOneTimePrekeysIfNeeded(userId, record.deviceId)
    .catch((error) => console.warn('[DEVICE] OPK refill deferred:', error));
  await ensureApprovedDeviceTrust(userId, record.deviceId);
  // Invariant corrigé : la préparation des clés s'arrête à la route prête. La
  // finalisation serveur (`complete_current_device_synchronization`) n'a lieu
  // qu'APRÈS la vraie synchronisation des clés de compte.
  const updated = await readDeviceRecord(userId, record.deviceId);
  if (!updated || updated.routingStatus !== 'ready') throw new Error('DEVICE_KEY_SETUP_INCOMPLETE');
  return updated;
}

/**
 * Finalisation serveur du cycle de vie appareil.
 *
 * Invariant cryptographique : appelée uniquement après une synchronisation des
 * clés de compte réellement réussie. Elle est la SEULE transition vers
 * `lifecycle_status='ready'` et vérifie ce statut après exécution.
 */
async function finalizeSynchronization(userId: string): Promise<DeviceApiRecord> {
  const snapshot = await getState(userId);
  const record = snapshot.record;
  if (!record) throw new Error('DEVICE_NOT_FOUND');
  if (record.revokedAt || record.approvalStatus !== 'approved' || !record.isActive) throw new Error('DEVICE_NOT_APPROVED');
  if (record.bindingStatus !== 'bound' || record.routingStatus !== 'ready') {
    throw new Error('DEVICE_ROUTE_NOT_READY');
  }
  if (record.lifecycleStatus === 'ready') return record;

  const { data, error } = await runDeviceRpcWithTimeout(
    'DEVICE_SYNCHRONIZATION_INCOMPLETE',
    (signal) => supabase.rpc('complete_current_device_synchronization' as never, {
      p_device_id: record.deviceId,
    } as never).abortSignal(signal),
  );
  const result = data as { ok?: boolean; code?: string } | null;
  if (error || result?.ok !== true) {
    throw new Error(`DEVICE_SYNCHRONIZATION_INCOMPLETE:${result?.code ?? error?.message ?? 'UNKNOWN'}`);
  }
  const updated = await readDeviceRecord(userId, record.deviceId);
  if (!updated || updated.lifecycleStatus !== 'ready') throw new Error('DEVICE_SYNCHRONIZATION_INCOMPLETE');
  return updated;
}

/**
 * Invariant cryptographique : la maintenance périodique ne PRÉPARE jamais un
 * appareil. Elle exige un état serveur complet (approuvé, actif, lié, route
 * prête, `lifecycle_status='ready'`), ne provisionne pas libsignal et ne touche
 * ni `routing_status` ni `lifecycle_status`. Elle renouvelle uniquement la
 * préclé signée expirante et recharge le pool de préclés à usage unique.
 */
async function runKeyMaintenance(userId: string): Promise<DeviceApiRecord> {
  const snapshot = await getState(userId);
  const record = snapshot.record;
  if (!record || snapshot.state !== 'ready') throw new Error('DEVICE_MAINTENANCE_NOT_READY');
  if (record.routingStatus !== 'ready' || record.lifecycleStatus !== 'ready') {
    throw new Error('DEVICE_MAINTENANCE_NOT_READY');
  }
  const identity = await loadDeviceIdentity(userId, record.deviceId);
  if (!identity) throw new Error('DEVICE_LOCAL_PRIVATE_KEYS_MISSING');
  await refreshDeviceSignedPrekeyIfNeeded(userId, record.deviceId, identity.privateKey);
  await refillDeviceOneTimePrekeysIfNeeded(userId, record.deviceId);
  return record;
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
  autoApprove: (userId: string) => withIosDiagnostics('deviceApi.autoApprove', () => autoApprove(userId)),
  bind: (userId: string) => runDeviceTransitionOnce(
    bindInFlight,
    userId,
    () => withIosDiagnostics('deviceApi.bind', () => bind(userId)),
  ),
  prepareKeys: (userId: string) => runDeviceTransitionOnce(
    keySetupInFlight,
    userId,
    () => withIosDiagnostics('deviceApi.prepareKeys', () => prepareKeys(userId)),
  ),
  finalizeSynchronization: (userId: string) => runDeviceTransitionOnce(
    keySetupInFlight,
    userId,
    () => withIosDiagnostics('deviceApi.finalizeSynchronization', () => finalizeSynchronization(userId)),
  ),
  // Même verrou que `prepareKeys` : aucune exécution concurrente possible.
  runKeyMaintenance: async (userId: string): Promise<void> => {
    await runDeviceTransitionOnce(
      keySetupInFlight,
      userId,
      () => withIosDiagnostics('deviceApi.runKeyMaintenance', () => runKeyMaintenance(userId)),
    );
  },
  revokeDevice,
} as const;
