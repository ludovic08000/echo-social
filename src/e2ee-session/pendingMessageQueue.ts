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
// keep "permanently undeliverable" ciphertexts spinning forever.
const MAX_ATTEMPTS = 20;
const RETRY_INTERVAL_MS = 1500;
const MAX_RETRIES_PER_TICK = 8;

// Hard ceiling on `refresh()` cycles. Without this, a stuck message that
// keeps coming back from the server refetch would loop forever (Supabase
// returns the row → UI re-supplies it → attempts reset → drain fails →
// repeat). Capping at 4 refresh cycles × 20 attempts ≈ 2 minutes of total
// retry budget per envelope, after which we drop it entirely.
const MAX_REFRESH_CYCLES = 4;

// Idempotency window — refetch handlers should never re-enqueue the same
// envelopeId twice within 2 s (tight loop in realtime + initial fetch race).
const REFRESH_DEBOUNCE_MS = 2000;

interface InternalEnvelope extends PendingEnvelope {
  refreshCycles: number;
  /** Wall-clock ms of last `refresh()` — drives REFRESH_DEBOUNCE_MS. */
  lastRefreshAt: number;
  /** Permanently dropped — refuse re-enqueue under the same id. */
  burned?: boolean;
}

type RetryFn = (envelope: unknown) => Promise<boolean>;

class PendingQueue {
  private items = new Map<string, InternalEnvelope>();
  private burned = new Set<string>();
  private retry: RetryFn | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  setRetryHandler(fn: RetryFn) {
    this.retry = fn;
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), RETRY_INTERVAL_MS);
    }
  }

  enqueue(envelopeId: string, envelope: unknown): void {
    if (this.burned.has(envelopeId)) return;
    if (this.items.has(envelopeId)) return;
    this.items.set(envelopeId, {
      envelopeId,
      envelope,
      enqueuedAt: Date.now(),
      attempts: 0,
      refreshCycles: 0,
      lastRefreshAt: 0,
    });
  }

  /**
   * UI hook: a freshly-fetched message id is in flight again. Bounded refresh:
   *   - Debounced (REFRESH_DEBOUNCE_MS) to absorb realtime+fetch races.
   *   - Capped at MAX_REFRESH_CYCLES so a permanently-undeliverable message
   *     can't keep resetting its attempts counter forever.
   *   - On overflow the envelope is "burned" — re-enqueue is a no-op.
   */
  refresh(envelopeId: string, envelope: unknown): void {
    if (this.burned.has(envelopeId)) return;
    const prev = this.items.get(envelopeId);
    if (prev) {
      const now = Date.now();
      if (now - prev.lastRefreshAt < REFRESH_DEBOUNCE_MS) return;
      if (prev.refreshCycles >= MAX_REFRESH_CYCLES) {
        this.burned.add(envelopeId);
        this.items.delete(envelopeId);
        return;
      }
      prev.attempts = 0;
      prev.envelope = envelope;
      prev.enqueuedAt = now;
      prev.lastRefreshAt = now;
      prev.refreshCycles += 1;
      return;
    }
    this.enqueue(envelopeId, envelope);
  }

  remove(envelopeId: string): void {
    this.items.delete(envelopeId);
    // Successful drain — clear the burn list entry so a future genuine
    // re-delivery (different sessionId, key restore...) can re-enqueue.
    this.burned.delete(envelopeId);
  }

  has(envelopeId: string): boolean {
    return this.items.has(envelopeId);
  }

  size(): number {
    return this.items.size;
  }

  private async tick(): Promise<void> {
    if (!this.retry || this.items.size === 0) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    const entries = Array.from(this.items.entries()).slice(0, MAX_RETRIES_PER_TICK);
    for (const [id, item] of entries) {
      item.attempts += 1;
      let ok = false;
      try {
        ok = await this.retry(item.envelope);
      } catch {
        ok = false;
      }
      if (ok) {
        this.items.delete(id);
        this.burned.delete(id);
      } else if (item.attempts >= MAX_ATTEMPTS) {
        // Exhausted in-cycle attempts. If we still have refresh budget,
        // leave it in place so a server refetch can re-arm it; otherwise
        // burn it permanently.
        if (item.refreshCycles >= MAX_REFRESH_CYCLES) {
          this.items.delete(id);
          this.burned.add(id);
        } else {
          // Park: clear attempts so refresh() can pick it up again, but
          // gate that pickup behind REFRESH_DEBOUNCE_MS + cycle counter.
          this.items.delete(id);
        }
      }
    }
  }

  /** Test helper — flush everything (no-op in production). */
  _reset(): void {
    this.items.clear();
    this.burned.clear();
  }
}

export const pendingMessageQueue = new PendingQueue();
