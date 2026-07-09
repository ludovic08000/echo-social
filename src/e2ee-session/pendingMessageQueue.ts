/**
 * Bounded background retry queue for inbound E2EE envelopes.
 *
 * This is the Sesame-style "eventually converge" layer: if a message arrives
 * before its ratchet/device-copy state is ready, keep the envelope and retry
 * off the render path. The UI stays stable, and successful retries emit the
 * global decrypt event so mounted bubbles can read the plaintext cache.
 */
import type { PendingEnvelope } from './types';

const MAX_ATTEMPTS = 8;
const MAX_ITEMS = 500;
const BATCH_SIZE = 8;
const BASE_DELAY_MS = 750;
const MAX_DELAY_MS = 15_000;

type RetryHandler = (envelope: unknown) => Promise<boolean>;

function nextDelay(attempts: number): number {
  const exp = BASE_DELAY_MS * Math.pow(1.8, Math.max(0, attempts - 1));
  return Math.min(MAX_DELAY_MS, Math.round(exp));
}

class PendingQueue {
  private items = new Map<string, PendingEnvelope>();
  private retryHandler: RetryHandler | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private processing = false;

  setRetryHandler(fn: RetryHandler) {
    this.retryHandler = fn;
    this.schedule(0);
  }

  kick(): void {
    this.schedule(0);
  }

  enqueue(envelopeId: string, envelope: unknown): void {
    this.upsert(envelopeId, envelope, false);
  }

  refresh(envelopeId: string, envelope: unknown): void {
    this.upsert(envelopeId, envelope, true);
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

  _reset(): void {
    this.items.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.processing = false;
  }

  private upsert(envelopeId: string, envelope: unknown, preserveAttempts: boolean): void {
    if (!envelopeId) return;
    const existing = this.items.get(envelopeId);
    this.items.set(envelopeId, {
      envelopeId,
      envelope,
      enqueuedAt: existing?.enqueuedAt ?? Date.now(),
      attempts: preserveAttempts ? (existing?.attempts ?? 0) : 0,
    });

    while (this.items.size > MAX_ITEMS) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this.items.delete(oldest);
    }

    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (!this.retryHandler || this.processing) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.process();
    }, delayMs);
  }

  private async process(): Promise<void> {
    if (!this.retryHandler || this.processing || this.items.size === 0) return;
    this.processing = true;
    let shortestDelay = MAX_DELAY_MS;

    try {
      const batch = Array.from(this.items.values()).slice(0, BATCH_SIZE);
      for (const item of batch) {
        const handler = this.retryHandler;
        if (!handler) break;

        const attempts = item.attempts + 1;
        try {
          const ok = await handler(item.envelope);
          if (ok) {
            this.items.delete(item.envelopeId);
            continue;
          }
        } catch {
          // Keep the item for a bounded retry unless attempts are exhausted.
        }

        if (attempts >= MAX_ATTEMPTS) {
          this.items.delete(item.envelopeId);
          continue;
        }

        this.items.set(item.envelopeId, { ...item, attempts });
        shortestDelay = Math.min(shortestDelay, nextDelay(attempts));
      }
    } finally {
      this.processing = false;
      if (this.items.size > 0) this.schedule(shortestDelay);
    }
  }
}

export const pendingMessageQueue = new PendingQueue();

export function processPendingMessages(): void {
  pendingMessageQueue.kick();
}
