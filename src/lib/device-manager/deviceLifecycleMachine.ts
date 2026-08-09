/**
 * Machine d'état du cycle de vie appareil Aegis.
 *
 * Invariant corrigé : l'ordre est strict et non contournable.
 * AUTHENTICATED -> DEVICE_CREDENTIAL_CHECK -> LINK_REQUIRED/PENDING_APPROVAL
 * -> APPROVED_LOCKED -> PIN_UNLOCK -> ACCOUNT_KEY_SYNC -> MESSAGING_READY
 *
 * Cette fonction est pure : aucun accès réseau, aucun effet de bord, aucune
 * exception. Les signaux matériels (UA, écran, timezone) ne servent jamais à
 * établir la confiance : seuls l'état serveur signé et le PIN local comptent.
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

export type DeviceIdStatus =
  | 'ok'
  | 'uninitialized'
  | 'mismatch'
  | 'storage_unavailable';

export type DeviceApprovalStatus = 'pending' | 'approved' | 'rejected' | null;

export interface DeviceLifecycleRecord {
  deviceId: string;
  approvalStatus: DeviceApprovalStatus;
  isActive: boolean | null;
  revokedAt: string | null;
}

export type AccountSyncPhaseInput = 'idle' | 'syncing' | 'ready' | 'failed';

export interface DeviceLifecycleInput {
  authenticated: boolean;
  /** `unknown` = la lecture serveur n'a pas encore répondu. */
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
  | 'account_sync_running'
  | 'ready';

export interface DeviceLifecycleResolution {
  state: AegisDeviceLifecycleState;
  reason: DeviceLifecycleReason;
}

export function lifecycleRank(state: AegisDeviceLifecycleState): number {
  return AEGIS_DEVICE_LIFECYCLE_ORDER.indexOf(state);
}

export function resolveDeviceLifecycleState(
  input: DeviceLifecycleInput,
): DeviceLifecycleResolution {
  if (!input.authenticated) {
    return { state: 'AUTHENTICATED', reason: 'not_authenticated' };
  }

  if (input.deviceIdStatus === 'mismatch') {
    // État contrôlé, jamais une exception fatale de rendu.
    return { state: 'LINK_REQUIRED', reason: 'device_id_reapproval_required' };
  }
  if (input.deviceIdStatus === 'storage_unavailable') {
    return { state: 'LINK_REQUIRED', reason: 'device_id_unavailable' };
  }

  if (input.deviceRecord === 'unknown') {
    return { state: 'DEVICE_CREDENTIAL_CHECK', reason: 'credential_check_in_progress' };
  }

  if (input.deviceIdStatus === 'uninitialized' || input.deviceRecord === null) {
    // L'appareil n'a pas encore de credential enrôlée côté serveur.
    return { state: 'DEVICE_CREDENTIAL_CHECK', reason: 'credential_check_in_progress' };
  }

  const record = input.deviceRecord;

  if (record.approvalStatus === 'rejected') {
    return { state: 'LINK_REQUIRED', reason: 'device_rejected' };
  }
  if (record.revokedAt) {
    return { state: 'LINK_REQUIRED', reason: 'device_revoked' };
  }
  if (record.approvalStatus === 'pending') {
    return { state: 'PENDING_APPROVAL', reason: 'awaiting_approval' };
  }
  if (record.approvalStatus !== 'approved') {
    return { state: 'PENDING_APPROVAL', reason: 'awaiting_approval' };
  }
  if (record.isActive !== true) {
    return { state: 'LINK_REQUIRED', reason: 'device_inactive' };
  }

  if (!input.pinUnlocked) {
    return { state: 'APPROVED_LOCKED', reason: 'awaiting_pin_unlock' };
  }

  if (input.accountSyncPhase === 'syncing') {
    return { state: 'ACCOUNT_KEY_SYNC', reason: 'account_sync_running' };
  }
  if (input.accountSyncPhase === 'ready') {
    return { state: 'MESSAGING_READY', reason: 'ready' };
  }
  return { state: 'PIN_UNLOCK', reason: 'awaiting_pin_unlock' };
}

/** Enrôlement / lecture d'état serveur : aucun secret n'est manipulé ici. */
export function canRunDeviceCredentialWork(state: AegisDeviceLifecycleState): boolean {
  return lifecycleRank(state) >= lifecycleRank('DEVICE_CREDENTIAL_CHECK');
}

/**
 * AccountKeySync, crypto maintenance, polling de device, fanout et inbox E2EE
 * ne démarrent qu'après APPROVED_LOCKED puis déverrouillage du PIN.
 */
export function canRunCryptoRuntime(state: AegisDeviceLifecycleState): boolean {
  return lifecycleRank(state) >= lifecycleRank('PIN_UNLOCK');
}

/** Le PIN ne peut jamais s'afficher avant l'approbation de l'appareil. */
export function canPromptForPin(state: AegisDeviceLifecycleState): boolean {
  return lifecycleRank(state) >= lifecycleRank('APPROVED_LOCKED');
}

export function requiresDeviceApprovalUi(state: AegisDeviceLifecycleState): boolean {
  return state === 'LINK_REQUIRED'
    || state === 'PENDING_APPROVAL'
    || state === 'DEVICE_CREDENTIAL_CHECK';
}
