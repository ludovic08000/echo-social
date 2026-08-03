export interface ServerContinuityProbe {
  activeIdentity: boolean;
  accountBackup: boolean;
  activeIdentityError: boolean;
  accountBackupError: boolean;
}

export type ServerContinuityDecision = 'clear' | 'continuity' | 'unavailable';

export function evaluateServerContinuityProbe(
  probe: ServerContinuityProbe,
): ServerContinuityDecision {
  if (
    probe.activeIdentityError ||
    probe.accountBackupError
  ) {
    return 'unavailable';
  }

  return probe.activeIdentity || probe.accountBackup
    ? 'continuity'
    : 'clear';
}

export function createSingleFlightByKey<T>() {
  const flights = new Map<string, Promise<T>>();

  return (key: string, factory: () => Promise<T>): Promise<T> => {
    const existing = flights.get(key);
    if (existing) return existing;

    const flight = factory().finally(() => {
      if (flights.get(key) === flight) flights.delete(key);
    });
    flights.set(key, flight);
    return flight;
  };
}

export interface MasterKeyContinuityProbe {
  complete: boolean;
  localIdentityFingerprint: string | null;
  activeIdentityFingerprint: string | null;
  hasAccountBackup: boolean;
  hasRecoveryBackup: boolean;
}

export type MasterKeyCreationDecision =
  | 'create_first_key'
  | 'recovery_required'
  | 'identity_mismatch'
  | 'no_local_identity'
  | 'unavailable';

export function decideMasterKeyCreation(
  probe: MasterKeyContinuityProbe,
): MasterKeyCreationDecision {
  if (!probe.complete) return 'unavailable';
  if (
    probe.hasAccountBackup ||
    probe.hasRecoveryBackup
  ) {
    return 'recovery_required';
  }
  if (!probe.localIdentityFingerprint) return 'no_local_identity';
  if (
    probe.activeIdentityFingerprint &&
    probe.activeIdentityFingerprint !== probe.localIdentityFingerprint
  ) {
    return 'identity_mismatch';
  }
  return 'create_first_key';
}

export function selectPortableAccountIdentityRows<T extends { id?: unknown }>(
  rows: T[],
  userId: string,
): T[] {
  return rows.filter((row) => row?.id === userId);
}

export type PasswordChangeReadiness =
  | 'ready'
  | 'no_backup'
  | 'recovery_required'
  | 'unavailable';

/** Invariant : Auth ne change pas tant que la continuité Master Key est incertaine. */
export function decidePasswordChangeReadiness(input: {
  hasActiveMasterKey: boolean;
  hasAccountBackup: boolean;
  inspectionFailed: boolean;
}): PasswordChangeReadiness {
  if (input.hasActiveMasterKey) return 'ready';
  if (input.inspectionFailed) return 'unavailable';
  return input.hasAccountBackup ? 'recovery_required' : 'no_backup';
}
