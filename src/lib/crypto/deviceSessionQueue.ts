const localChains = new Map<string, Promise<void>>();
const LOCK_WAIT_TIMEOUT_MS = 12_000;

export class DeviceSessionLockTimeoutError extends Error {
  readonly code = 'E2EE_DEVICE_SESSION_LOCK_TIMEOUT';

  constructor() {
    super('Device session lock timeout');
    this.name = 'DeviceSessionLockTimeoutError';
  }
}

function hasWebLocks(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
}

async function runWithLocalQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = localChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  localChains.set(key, tail);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (localChains.get(key) === tail) localChains.delete(key);
  }
}

/**
 * Serializes every mutation of one device-pair state. The scope separates the
 * complete X3DH/initiating-envelope operation from the nested ratchet writes,
 * while each scope remains exclusive across tabs through Web Locks.
 */
export async function runDeviceSessionJob<T>(
  scope: 'route' | 'ratchet',
  pairKey: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = `${scope}:${pairKey}`;
  if (!hasWebLocks()) return runWithLocalQueue(key, task);

  const controller = new AbortController();
  let acquired = false;
  const timer = setTimeout(() => {
    if (!acquired) controller.abort();
  }, LOCK_WAIT_TIMEOUT_MS);

  try {
    return await navigator.locks.request(
      `sesame:device-session:${key}`,
      { mode: 'exclusive', signal: controller.signal },
      async () => {
        acquired = true;
        clearTimeout(timer);
        return task();
      },
    );
  } catch (error) {
    if (controller.signal.aborted && !acquired) throw new DeviceSessionLockTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const __test__ = {
  reset(): void {
    localChains.clear();
  },
};
