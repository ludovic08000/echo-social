/**
 * Pending message queue — keeps out-of-order or transiently-undecryptable
 * envelopes in MEMORY only and retries them.
 *
 * iOS Safari nuance: this tab is regularly suspended. We therefore drive
 * retries from `online` / `focus` / `pageshow` / `visibilitychange` events
 * in addition to the periodic tick, so a backgrounded conversation is
 * processed *immediately* when the user returns instead of waiting for the
 * next tick.
 *
 * On reload nothing is persisted locally. The message-list refetch
 * re-supplies the ciphertext from `messages` / `message_device_copies`
 * and `routeIncoming` re-enqueues automatically. Plaintext is never
 * stored on disk (project rule: keys+plaintext live in RAM only).
 */
import type { PendingEnvelope } from './types';

// Keep retries short and bounded. Missing historical copies must settle into a
// stable parked state instead of burning CPU/network in the background.
const MAX_ATTEMPTS = 12;
const RETRY_INTERVAL_MS = 1500;
const MAX_RETRIES_PER_TICK = 8;

// Refresh cycles allow a server refetch to re-arm a parked envelope. Bounded
// so a permanently-undeliverable ciphertext can't loop forever.
const MAX_REFRESH_CYCLES = 2;
const REFRESH_DEBOUNCE_MS = 2000;

// Event-driven kick debounce — avoid stacking 4 ticks in a row when iOS
// fires online + focus + pageshow + visibilitychange back to back.
const KICK_DEBOUNCE_MS = 250;

interface InternalEnvelope extends PendingEnvelope {
  refreshCycles: number;
  lastRefreshAt: number;
  burned?: boolean;
}

type RetryFn = (envelope: unknown) => Promise<boolean>;

class PendingQueue {
  private items = new Map<string, InternalEnvelope>();
  private burned = new Set<string>();
  private refreshCounts = new Map<string, number>();
  private retry: RetryFn | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKickAt = 0;
  private listenersWired = false;

  setRetryHandler(fn: RetryFn) {
    this.retry = fn;
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), RETRY_INTERVAL_MS);
    }
    this.wireResumeListeners();
  }

  /**
   * Wire `online` / `focus` / `pageshow` / `visibilitychange` so the queue
   * drains *immediately* when iOS returns from background instead of waiting
   * for the next periodic tick. Idempotent.
   */
  private wireResumeListeners() {
    if (this.listenersWired) return;
    if (typeof window === 'undefined') return;
    this.listenersWired = true;

    const kick = () => this.kick();
    window.addEventListener('online', kick);
    window.addEventListener('focus', kick);
    window.addEventListener('pageshow', kick);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) this.kick();
      });
    }
  }

  /** External hook — UI may also call this after a successful key restore. */
  kick(): void {
    const now = Date.now();
    if (now - this.lastKickAt < KICK_DEBOUNCE_MS) return;
    this.lastKickAt = now;
    void this.tick();
  }

  enqueue(envelopeId: string, envelope: unknown): void {
    if (this.burned.has(envelopeId)) return;
    if (this.items.has(envelopeId)) return;
    const refreshCycles = this.refreshCounts.get(envelopeId) ?? 0;
    this.items.set(envelopeId, {
      envelopeId,
      envelope,
      enqueuedAt: Date.now(),
      attempts: 0,
      refreshCycles,
      lastRefreshAt: 0,
    });
  }

  /**
   * Re-arm an envelope after a server refetch. Bounded by MAX_REFRESH_CYCLES.
   */
  refresh(envelopeId: string, envelope: unknown): void {
    if (this.burned.has(envelopeId)) return;
    const previousRefreshCycles = this.refreshCounts.get(envelopeId) ?? 0;
    if (previousRefreshCycles >= MAX_REFRESH_CYCLES) {
      this.burned.add(envelopeId);
      this.items.delete(envelopeId);
      return;
    }

    const prev = this.items.get(envelopeId);
    if (prev) {
      const now = Date.now();
      if (now - prev.lastRefreshAt < REFRESH_DEBOUNCE_MS) return;
      const nextRefreshCycles = previousRefreshCycles + 1;
      this.refreshCounts.set(envelopeId, nextRefreshCycles);
      prev.attempts = 0;
      prev.envelope = envelope;
      prev.enqueuedAt = now;
      prev.lastRefreshAt = now;
      prev.refreshCycles = nextRefreshCycles;
      return;
    }
    const now = Date.now();
    this.refreshCounts.set(envelopeId, previousRefreshCycles + 1);
    this.enqueue(envelopeId, envelope);
    const next = this.items.get(envelopeId);
    if (next) next.lastRefreshAt = now;
  }

  remove(envelopeId: string): void {
    this.items.delete(envelopeId);
    this.burned.delete(envelopeId);
    this.refreshCounts.delete(envelopeId);
  }

  has(envelopeId: string): boolean {
    return this.items.has(envelopeId);
  }

  size(): number {
    return this.items.size;
  }

  private async tick(): Promise<void> {
    if (!this.retry || this.items.size === 0) return;
    // While the tab is hidden we DEFER (don't drop) — a kick on the next
    // visibilitychange/pageshow will drain the queue at that point.
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
        this.refreshCounts.delete(id);
      } else if (item.attempts >= MAX_ATTEMPTS) {
        // Park the envelope. If we still have refresh budget, the next
        // server refetch can re-arm it; otherwise it's burned.
        const refreshCycles = this.refreshCounts.get(id) ?? item.refreshCycles;
        if (refreshCycles >= MAX_REFRESH_CYCLES) {
          this.items.delete(id);
          this.burned.add(id);
        } else {
          this.items.delete(id);
        }
      }
    }
  }

  /** Test helper. */
  _reset(): void {
    this.items.clear();
    this.burned.clear();
    this.refreshCounts.clear();
    this.lastKickAt = 0;
  }
}

export const pendingMessageQueue = new PendingQueue();

/** Public API mirror — `processPendingMessages()` triggers a drain. */
export function processPendingMessages(): void {
  pendingMessageQueue.kick();
}
