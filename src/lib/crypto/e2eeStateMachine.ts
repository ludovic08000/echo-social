export type E2EEMachineStatus = 'LOCKED' | 'READY' | 'BLOCKED';

export type E2EEMachineReason =
  | 'zeus'
  | 'ready'
  | 'first_setup_required'
  | 'pin_unlock_required'
  | 'identity_restore_required'
  | 'identity_server_unavailable'
  | 'identity_fingerprint_mismatch'
  | 'fingerprint_changed'
  | 'peer_key_missing'
  | 'own_keys_missing'
  | 'peer_keys_missing'
  | 'not_encrypted'
  | 'initializing';

export interface E2EEMachineInput {
  isZeus: boolean;
  encrypted: boolean;
  hasOwnKeys: boolean;
  hasPeerKey: boolean;
  fingerprintChanged?: boolean;
  peerKeyMissing?: boolean;
  initError?: string | null;
}

export interface E2EEMachineState {
  status: E2EEMachineStatus;
  reason: E2EEMachineReason;
  canEncrypt: boolean;
  canSend: boolean;
}

const BLOCKING_ERRORS = new Set([
  'identity_fingerprint_mismatch',
  'fingerprint_changed',
]);

const LOCKED_REASON_BY_ERROR = new Map<string, E2EEMachineReason>([
  ['pin_setup_required', 'first_setup_required'],
  ['pin_unlock_required', 'pin_unlock_required'],
  ['identity_lost_backup_available', 'identity_restore_required'],
  ['identity_restore_required', 'identity_restore_required'],
  ['identity_server_unavailable', 'identity_server_unavailable'],
  ['Peer key fetch failed', 'peer_keys_missing'],
  ['Key initialization failed', 'initializing'],
]);

function state(status: E2EEMachineStatus, reason: E2EEMachineReason): E2EEMachineState {
  return {
    status,
    reason,
    canEncrypt: status === 'READY',
    canSend: status !== 'BLOCKED',
  };
}

export function deriveE2EEState(input: E2EEMachineInput): E2EEMachineState {
  if (input.isZeus) return state('READY', 'zeus');

  if (input.fingerprintChanged) return state('BLOCKED', 'fingerprint_changed');

  const initError = input.initError || null;
  if (initError && BLOCKING_ERRORS.has(initError)) {
    return state('BLOCKED', initError as E2EEMachineReason);
  }

  if (initError) {
    return state('LOCKED', LOCKED_REASON_BY_ERROR.get(initError) ?? 'initializing');
  }

  if (input.peerKeyMissing) return state('LOCKED', 'peer_key_missing');
  if (!input.hasOwnKeys) return state('LOCKED', 'own_keys_missing');
  if (!input.hasPeerKey) return state('LOCKED', 'peer_keys_missing');
  if (!input.encrypted) return state('LOCKED', 'not_encrypted');

  return state('READY', 'ready');
}
