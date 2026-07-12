import { fanoutMessageCopies } from '@/lib/messaging/multiDeviceFanout';

type FanoutInput = Parameters<typeof fanoutMessageCopies>[0];
type FanoutResult = Awaited<ReturnType<typeof fanoutMessageCopies>>;
type FanoutAttempt = (input: FanoutInput) => Promise<FanoutResult>;

export const DEFAULT_FANOUT_REPAIR_DELAYS_MS = [0, 500, 1_500, 4_000] as const;

export function fanoutNeedsRepair(
  result: { rows: unknown[]; hasTargets: boolean } | null,
): boolean {
  return result === null || (result.hasTargets && result.rows.length === 0);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A fan-out attempt that detects target devices but inserts zero copies is not
 * a success. Retry with bounded backoff so iOS/Windows prekey publication and
 * session hydration have time to settle. No plaintext is sent to the server;
 * every attempt still uses the existing per-device E2EE fan-out function.
 */
export async function repairFanoutWithRetry(
  input: FanoutInput,
  attempt: FanoutAttempt = fanoutMessageCopies,
  delaysMs: readonly number[] = DEFAULT_FANOUT_REPAIR_DELAYS_MS,
): Promise<FanoutResult> {
  let lastResult: FanoutResult | null = null;
  let lastError: unknown = null;

  for (const delay of delaysMs) {
    await sleep(delay);
    try {
      const result = await attempt(input);
      lastResult = result;
      lastError = null;

      // No target means there is nothing to repair. One or more inserted rows
      // means the recipient devices now have durable copies.
      if (!result.multiDevice || result.inserted > 0) return result;
    } catch (error) {
      lastError = error;
    }
  }

  const failure = new Error('E_FANOUT_ZERO_COPIES_AFTER_RETRY');
  (failure as Error & { cause?: unknown; lastResult?: FanoutResult | null }).cause = lastError;
  (failure as Error & { cause?: unknown; lastResult?: FanoutResult | null }).lastResult = lastResult;
  throw failure;
}
