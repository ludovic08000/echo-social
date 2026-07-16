// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Browser send scheduler modelled after Signal Desktop's conversation job queue.
 *
 * The transport and cryptography stay owned by Sesame. This module only gives
 * the web client the queue guarantees that matter for stable delivery:
 *   - one active send/retry per conversation;
 *   - cross-tab exclusion through the Web Locks API when available;
 *   - bounded retry with increasing delay;
 *   - idempotent timer registration.
 */

const conversationChains = new Map<string, Promise<void>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryAttempts = new Map<string, number>();

const RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;
const MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length;
const LOCK_ACQUIRE_TIMEOUT_MS = 12_000;

export class SignalConversationLockTimeoutError extends Error {
  readonly code = 'E2EE_ENCRYPT_LOCK_TIMEOUT';

  constructor() {
    super('E2EE encryption lock timeout — automatic retry scheduled');
    this.name = 'SignalConversationLockTimeoutError';
  }
}

function lockName(conversationKey: string): string {
  return `sesame:message-send:${conversationKey}`;
}

function hasWebLocks(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
}

async function runWithMemoryLock<T>(conversationKey: string, task: () => Promise<T>): Promise<T> {
  const previous = conversationChains.get(conversationKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  conversationChains.set(conversationKey, tail);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (conversationChains.get(conversationKey) === tail) {
      conversationChains.delete(conversationKey);
    }
  }
}

export async function runSignalConversationJob<T>(
  conversationKey: string,
  task: () => Promise<T>,
): Promise<T> {
  if (hasWebLocks()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOCK_ACQUIRE_TIMEOUT_MS);
    try {
      return await navigator.locks.request(
        lockName(conversationKey),
        { mode: 'exclusive', signal: controller.signal },
        task,
      );
    } catch (error) {
      if (controller.signal.aborted) throw new SignalConversationLockTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return runWithMemoryLock(conversationKey, task);
}

export function retryDelayMs(attempt: number): number {
  const index = Math.max(0, Math.min(Math.floor(attempt), RETRY_DELAYS_MS.length - 1));
  return RETRY_DELAYS_MS[index];
}

export function cancelSignalRetry(retryKey: string): void {
  const timer = retryTimers.get(retryKey);
  if (timer !== undefined) clearTimeout(timer);
  retryTimers.delete(retryKey);
  retryAttempts.delete(retryKey);
}

export function scheduleSignalRetry(
  retryKey: string,
  task: () => Promise<void>,
  options: { immediate?: boolean } = {},
): boolean {
  if (retryTimers.has(retryKey)) return true;

  const attempt = retryAttempts.get(retryKey) ?? 0;
  if (attempt >= MAX_RETRY_ATTEMPTS) return false;

  const delay = options.immediate ? 0 : retryDelayMs(attempt);
  const timer = setTimeout(() => {
    retryTimers.delete(retryKey);
    retryAttempts.set(retryKey, attempt + 1);
    void task()
      .then(() => {
        retryAttempts.delete(retryKey);
      })
      .catch(() => {
        // The hook will see the still-pending outbox row and schedule the next
        // bounded attempt. Keeping the count here prevents hot retry loops.
      });
  }, delay);
  retryTimers.set(retryKey, timer);
  return true;
}

export function isRetryableOutboundStatus(status: string, lastError?: string | null): boolean {
  if (status === 'retry_pending' || status === 'waiting_secure_channel') return true;
  if (status !== 'failed_visible') return false;

  const error = (lastError ?? '').toLowerCase();
  if (!error) return false;
  if (
    error.includes('session expir') ||
    error.includes('reconnectez-vous') ||
    error.includes('clé de sécurité') ||
    error.includes('safety number') ||
    error.includes('verification obligatoire') ||
    error.includes('fingerprint changed')
  ) {
    return false;
  }

  return [
    'network',
    'fetch',
    'timeout',
    'temporar',
    'connection',
    'hors ligne',
    'offline',
    'gateway',
    'rate limit',
    '502',
    '503',
    '504',
  ].some((marker) => error.includes(marker));
}

export const __test__ = {
  reset(): void {
    for (const timer of retryTimers.values()) clearTimeout(timer);
    conversationChains.clear();
    retryTimers.clear();
    retryAttempts.clear();
  },
};
