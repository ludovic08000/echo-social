/**
 * Bounded decrypt-retry accounting for inbound E2EE envelopes.
 *
 * Why
 * ---
 * A decrypt failure is often TRANSIENT: at cold start the ratchet state may not
 * be loaded yet, IndexedDB may still be opening, or a rehydration/self-heal is
 * mid-flight. The old router marked such an envelope as "seen" and dropped it
 * once — permanently losing a message that would have decrypted a moment later.
 * (seenMessageStore's own docs warn: "A pending retry must NOT mark the key.")
 *
 * This store lets the router leave a failed envelope UN-seen for a bounded
 * number of attempts, so the next re-route (realtime re-fire, app foreground,
 * queue resume) retries it — by which point the session is usually ready.
 * After MAX_DECRYPT_RETRIES the envelope is considered genuinely unreadable and
 * the router marks it seen + drops it, so we never retry forever.
 *
 * Scope: process lifetime, in-memory. A reload resets counts — which is
 * desirable, because a reload is exactly when the ratchet is freshly loaded.
 */

export const MAX_DECRYPT_RETRIES = 6;
/** Minimum spacing between attempts for the same envelope (anti-tight-loop). */
export const RETRY_COOLDOWN_MS = 1500;

const MAX_ENTRIES = 5000;

interface RetryEntry {
  attempts: number;
  lastAttemptAt: number;
}

const entries = new Map<string, RetryEntry>();

export interface RetryDecision {
  /** True if the caller should leave the envelope un-seen and retry later. */
  shouldRetry: boolean;
  /** True once attempts are exhausted — caller should mark seen + drop. */
  exhausted: boolean;
  attempts: number;
}

/**
 * Pure decision helper — exported for unit testing. Decides, given the current
 * entry (or undefined) and `now`, whether a further retry is warranted.
 */
export function decideRetry(
  entry: RetryEntry | undefined,
  now: number,
  maxRetries: number = MAX_DECRYPT_RETRIES,
): RetryDecision {
  const attempts = (entry?.attempts ?? 0) + 1;
  if (attempts >= maxRetries) {
    return { shouldRetry: false, exhausted: true, attempts };
  }
  return { shouldRetry: true, exhausted: false, attempts };
}

/**
 * Record a failed decrypt attempt for `key` and return whether to retry later
 * or give up. Applies a cooldown so repeated re-routes within RETRY_COOLDOWN_MS
 * don't burn through the attempt budget in one burst.
 */
export function noteRetryAttempt(key: string, now: number = Date.now()): RetryDecision {
  const existing = entries.get(key);

  if (existing && now - existing.lastAttemptAt < RETRY_COOLDOWN_MS) {
    // Within cooldown: treat as the same attempt, keep it retryable without
    // incrementing (so a burst of re-routes doesn't exhaust the budget).
    return {
      shouldRetry: existing.attempts < MAX_DECRYPT_RETRIES,
      exhausted: existing.attempts >= MAX_DECRYPT_RETRIES,
      attempts: existing.attempts,
    };
  }

  const decision = decideRetry(existing, now);
  entries.set(key, { attempts: decision.attempts, lastAttemptAt: now });

  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }

  return decision;
}

/** Clear retry accounting for a key (call on successful decrypt). */
export function clearRetry(key: string): void {
  entries.delete(key);
}

/** Test helper. */
export function _resetRetryStore(): void {
  entries.clear();
}
