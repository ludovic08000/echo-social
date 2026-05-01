/**
 * Pending message queue — keeps out-of-order or transiently-undecryptable
 * envelopes in MEMORY only and retries them on a short tick.
 *
 * Strategy (per user pick "RAM + refetch from server on reload"):
 *   - Live retries: 30 attempts × 1500 ms ≈ 45 s (covers wifi/4G handoffs,
 *     long Double Ratchet skip-windows, peer reconnect bursts).
 *   - On reload: nothing is persisted locally. The message-list refetch
 *     re-supplies the ciphertext from `messages` / `message_device_copies`
 *     and `routeIncoming` re-enqueues automatically. Plaintext is never
 *     stored on disk (project rule: keys+plaintext live in RAM only).
 *
 * Concurrency: tick() walks a snapshot of entries so retries can mutate the
 * map safely. Each retry is awaited sequentially to avoid fan-out storms
 * against the ratchet store (IndexedDB is single-writer per tx).
 */
import type { PendingEnvelope } from './types';

// Why 20 × 1.5 s ≈ 30 s: enough to cross a typical iOS Safari background→
// foreground resume + a peer ratchet catch-up, while bounded so we don't
// keep "permanently undeliverable" ciphertexts spinning forever. Lowered
// from 30 to reduce battery drain on iOS PWA when peer is offline long-term.
const MAX_ATTEMPTS = 20;
const RETRY_INTERVAL_MS = 1500;
// Soft cap on simultaneous retries per tick — prevents stampedes when many
// out-of-order messages land at once (large group chat catch-up).
const MAX_RETRIES_PER_TICK = 8;

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

  /** UI hook: a freshly-fetched message id is in flight again — give it a fresh budget. */
  refresh(envelopeId: string, envelope: unknown): void {
    const prev = this.items.get(envelopeId);
    if (prev) {
      prev.attempts = 0;
      prev.envelope = envelope;
      prev.enqueuedAt = Date.now();
      return;
    }
    this.enqueue(envelopeId, envelope);
  }

  remove(envelopeId: string): void {
    this.items.delete(envelopeId);
  }

  has(envelopeId: string): boolean {
    return this.items.has(envelopeId);
  }

  size(): number {
    return this.items.size;
  }

  private async tick(): Promise<void> {
    if (!this.retry || this.items.size === 0) return;

    // Skip retries when the tab is hidden — saves CPU/battery on iOS PWA
    // while still resuming on the next visibilitychange (forsure-decrypt-
    // retry event in the router fires the moment a message decrypts).
    if (typeof document !== 'undefined' && document.hidden) return;

    // Process the OLDEST entries first (FIFO), capped per tick to bound
    // bursts. Remaining entries roll over to the next interval naturally.
    const entries = Array.from(this.items.entries()).slice(0, MAX_RETRIES_PER_TICK);
    for (const [id, item] of entries) {
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
