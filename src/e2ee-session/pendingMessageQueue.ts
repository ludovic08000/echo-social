/**
 * Pending message queue — keeps out-of-order or transiently-undecryptable
 * envelopes in MEMORY only and retries them on a short tick.
 *
 * Why memory only:
 *   - Plaintext is never persisted to IndexedDB (project rule).
 *   - Encrypted blobs are already on the server (`messages` /
 *     `message_device_copies`); we don't need to persist them again.
 *   - Avoids growing local state across reloads if the peer never sends
 *     the missing chain message.
 *
 * Triggers a retry callback (provided by the caller) on a 1.5s interval,
 * up to MAX_ATTEMPTS times per envelope.
 */
import type { PendingEnvelope } from './types';

const MAX_ATTEMPTS = 8;
const RETRY_INTERVAL_MS = 1500;

type RetryFn = (envelope: unknown) => Promise<boolean>;

class PendingQueue {
  private items = new Map<string, PendingEnvelope>();
  private retry: RetryFn | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  setRetryHandler(fn: RetryFn) {
    this.retry = fn;
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), RETRY_INTERVAL_MS);
    }
  }

  enqueue(envelopeId: string, envelope: unknown): void {
    if (this.items.has(envelopeId)) return;
    this.items.set(envelopeId, {
      envelopeId,
      envelope,
      enqueuedAt: Date.now(),
      attempts: 0,
    });
  }

  remove(envelopeId: string): void {
    this.items.delete(envelopeId);
  }

  size(): number {
    return this.items.size;
  }

  private async tick(): Promise<void> {
    if (!this.retry || this.items.size === 0) return;
    for (const [id, item] of Array.from(this.items.entries())) {
      item.attempts += 1;
      let ok = false;
      try {
        ok = await this.retry(item.envelope);
      } catch {
        ok = false;
      }
      if (ok || item.attempts >= MAX_ATTEMPTS) {
        this.items.delete(id);
      }
    }
  }

  /** Test helper — flush everything (no-op in production). */
  _reset(): void {
    this.items.clear();
  }
}

export const pendingMessageQueue = new PendingQueue();
