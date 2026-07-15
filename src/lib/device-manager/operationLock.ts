type DeviceOperation = Promise<unknown>;

const activeOperations = new Map<string, DeviceOperation>();
const lastCompletedAt = new Map<string, number>();

export interface DeviceOperationOptions {
  /** Collapse concurrent callers onto the same promise. */
  coalesce?: boolean;
  /** Ignore repeated calls for this duration after a successful run. */
  cooldownMs?: number;
}

/**
 * Device identity, registration and prekey maintenance must never run in
 * parallel. Concurrent resyncs were generating several SPKs and could make one
 * caller classify the device as invalid while another caller was publishing it.
 */
export async function runDeviceOperation<T>(
  key: string,
  operation: () => Promise<T>,
  options: DeviceOperationOptions = {},
): Promise<T> {
  const coalesce = options.coalesce !== false;
  const existing = activeOperations.get(key) as Promise<T> | undefined;
  if (existing && coalesce) return existing;

  const cooldownMs = Math.max(0, options.cooldownMs ?? 0);
  const completedAt = lastCompletedAt.get(key) ?? 0;
  if (cooldownMs > 0 && Date.now() - completedAt < cooldownMs) {
    throw new Error(`DEVICE_OPERATION_COOLDOWN:${key}`);
  }

  const promise = operation()
    .then((result) => {
      lastCompletedAt.set(key, Date.now());
      return result;
    })
    .finally(() => {
      if (activeOperations.get(key) === promise) activeOperations.delete(key);
    });

  activeOperations.set(key, promise);
  return promise;
}

export function isDeviceOperationActive(key: string): boolean {
  return activeOperations.has(key);
}

export function clearDeviceOperationStateForTests(): void {
  activeOperations.clear();
  lastCompletedAt.clear();
}
