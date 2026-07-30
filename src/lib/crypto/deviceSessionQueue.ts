import {
  CrossTabLockTimeoutError,
  runCrossTabExclusive,
} from './crossTabLock';

const LOCK_WAIT_TIMEOUT_MS = 12_000;

export class DeviceSessionLockTimeoutError extends Error {
  readonly code = 'E2EE_DEVICE_SESSION_LOCK_TIMEOUT';

  constructor() {
    super('Device session lock timeout');
    this.name = 'DeviceSessionLockTimeoutError';
  }
}

/**
 * Serializes every mutation of one device-pair state. The scope separates the
 * complete X3DH/initiating-envelope operation from the nested ratchet writes,
 * while each scope remains exclusive across tabs even when Web Locks is absent.
 */
export async function runDeviceSessionJob<T>(
  scope: 'route' | 'ratchet',
  pairKey: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = `${scope}:${pairKey}`;
  try {
    return await runCrossTabExclusive(
      `aegis:device-session:${key}`,
      task,
      { waitTimeoutMs: LOCK_WAIT_TIMEOUT_MS, leaseMs: 60_000 },
    );
  } catch (error) {
    if (error instanceof CrossTabLockTimeoutError) {
      throw new DeviceSessionLockTimeoutError();
    }
    throw error;
  }
}

export const __test__ = {
  reset(): void {
    // Cross-tab lock state is released by each critical section. Kept for API
    // compatibility with existing tests.
  },
};
