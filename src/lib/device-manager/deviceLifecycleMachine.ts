/**
 * Machine d'état du cycle de vie appareil Aegis.
 *
 * Ordre strict : AUTHENTICATED -> DEVICE_CREDENTIAL_CHECK -> LINK_REQUIRED /
 * PENDING_APPROVAL -> APPROVED_LOCKED -> PIN_UNLOCK -> ACCOUNT_KEY_SYNC ->
 * MESSAGING_READY.
 *
 * Le binding cryptographique du device au compte est distinct de l'approbation:
 * un device approuvé mais non `bound` peut demander le PIN, mais ne peut jamais
 * démarrer le runtime E2EE, publier des prekeys ou router des messages.
 */

export const AEGIS_DEVICE_LIFECYCLE_ORDER = [
  'AUTHENTICATED',
  'DEVICE_CREDENTIAL_CHECK',
  'LINK_REQUIRED',
  'PENDING_APPROVAL',
  'APPROVED_LOCKED',
  'PIN_UNLOCK',
  'ACCOUNT_KEY_SYNC',
  'MESSAGING_READY',
] as const;

export type AegisDeviceLifecycleState = typeof AEGIS_DEVICE_LIFECYCLE_ORDER[number];

export type DeviceIdStatus = 'ok' | 'uninitialized' | 'mismatch' | 'storage_unavailable';
export type DeviceApprovalStatus = 'pending' | 'approved' | 'rejected' | null;
export type DeviceBindingStatus = 'pending' | 'bound' | 'revoked' | null;

export interface DeviceLifecycleRecord {
  deviceId: string;
  approvalStatus: DeviceApprovalStatus;
  bindingStatus?: DeviceBindingStatus;
  isActive: boolean | null;
  revokedAt: string | null;
}

export type AccountSyncPhaseInput = 'idle' | 'syncing' | 'ready' | 'failed';

export interface DeviceLifecycleInput {
  authenticated: boolean;
  deviceRecord: DeviceLifecycleRecord | null | 'unknown';
  deviceIdStatus: DeviceIdStatus;
  pinUnlocked: boolean;
  accountSyncPhase: AccountSyncPhaseInput;
}

export type DeviceLifecycleReason =
  | 'not_authenticated'
  | 'credential_check_in_progress'
  | 'device_id_unavailable'
  | 'device_id_reapproval_required'
  | 'device_rejected'
  | 'device_revoked'
  | 'device_inactive'
  | 'awaiting_approval'
  | 'awaiting_pin_unlock'
  | 'account_binding_pending'
  | 'account_sync_running'
  | 'ready';

export interface DeviceLifecycleResolution {
  state: AegisDeviceLifecycleState;
  reason: DeviceLifecycleReason;
}

export function lifecycleRank(state: AegisDeviceLifecycleState): number {
  return AEGIS_DEVICE_LIFECYCLE_ORDER.indexOf(state);
}

export function resolveDeviceLifecycleState(input: DeviceLifecycleInput): DeviceLifecycleResolution {
  if (!input.authenticated) return { state: 'AUTHENTICATED', reason: 'not_authenticated' };

  if (input.deviceIdStatus === 'mismatch') {
    return { state: 'LINK_REQUIRED', reason: 'device_id_reapproval_required' };
  }
  if (input.deviceIdStatus === 'storage_unavailable') {
    return { state: 'LINK_REQUIRED', reason: 'device_id_unavailable' };
  }
  if (input.deviceRecord === 'unknown') {
    return { state: 'DEVICE_CREDENTIAL_CHECK', reason: 'credential_check_in_progress' };
  }
  if (input.deviceIdStatus === 'uninitialized' || input.deviceRecord === null) {
    return { state: 'DEVICE_CREDENTIAL_CHECK', reason: 'credential_check_in_progress' };
  }

  const record = input.deviceRecord;
  if (record.approvalStatus === 'rejected') return { state: 'LINK_REQUIRED', reason: 'device_rejected' };
  if (record.revokedAt || record.bindingStatus === 'revoked') return { state: 'LINK_REQUIRED', reason: 'device_revoked' };
  if (record.approvalStatus === 'pending') return { state: 'PENDING_APPROVAL', reason: 'awaiting_approval' };
  if (record.approvalStatus !== 'approved') return { state: 'PENDING_APPROVAL', reason: 'awaiting_approval' };
  if (record.isActive !== true) return { state: 'LINK_REQUIRED', reason: 'device_inactive' };

  if (!input.pinUnlocked) return { state: 'APPROVED_LOCKED', reason: 'awaiting_pin_unlock' };

  // PIN is unlocked, but the account has not yet signed/authorized this device.
  if (record.bindingStatus !== 'bound') {
    return { state: 'PIN_UNLOCK', reason: 'account_binding_pending' };
  }

  if (input.accountSyncPhase === 'syncing') {
    return { state: 'ACCOUNT_KEY_SYNC', reason: 'account_sync_running' };
  }
  if (input.accountSyncPhase === 'ready') return { state: 'MESSAGING_READY', reason: 'ready' };
  return { state: 'PIN_UNLOCK', reason: 'awaiting_pin_unlock' };
}

export function canRunDeviceCredentialWork(state: AegisDeviceLifecycleState): boolean {
  return lifecycleRank(state) >= lifecycleRank('DEVICE_CREDENTIAL_CHECK');
}

export function canRunCryptoRuntime(state: AegisDeviceLifecycleState): boolean {
  return lifecycleRank(state) >= lifecycleRank('PIN_UNLOCK');
}

export function canPromptForPin(state: AegisDeviceLifecycleState): boolean {
  return lifecycleRank(state) >= lifecycleRank('APPROVED_LOCKED');
}

export function requiresDeviceApprovalUi(state: AegisDeviceLifecycleState): boolean {
  return state === 'LINK_REQUIRED' || state === 'PENDING_APPROVAL' || state === 'DEVICE_CREDENTIAL_CHECK';
}
