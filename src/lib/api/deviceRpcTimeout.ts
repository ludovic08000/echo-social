const DEVICE_FINALIZATION_RPC_TIMEOUT_MS = 20_000;

/**
 * Invariant cryptographique : une transition serveur de l'appareil doit soit
 * aboutir, soit échouer explicitement. Elle ne peut pas laisser l'interface
 * attendre indéfiniment avec une opération réseau encore ouverte.
 */
export async function runDeviceRpcWithTimeout<T>(
  operation: string,
  run: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs = DEVICE_FINALIZATION_RPC_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`${operation}:TIMEOUT`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([Promise.resolve(run(controller.signal)), timeout]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}
