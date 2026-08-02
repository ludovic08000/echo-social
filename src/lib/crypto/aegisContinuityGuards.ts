export interface ServerContinuityProbe {
  activeIdentity: boolean;
  accountBackup: boolean;
  backupPin: boolean;
  activeIdentityError: boolean;
  accountBackupError: boolean;
  backupPinError: boolean;
}

export type ServerContinuityDecision = 'clear' | 'continuity' | 'unavailable';

export function evaluateServerContinuityProbe(
  probe: ServerContinuityProbe,
): ServerContinuityDecision {
  if (
    probe.activeIdentityError ||
    probe.accountBackupError ||
    probe.backupPinError
  ) {
    return 'unavailable';
  }

  return probe.activeIdentity || probe.accountBackup || probe.backupPin
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
