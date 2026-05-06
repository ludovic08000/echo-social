/**
 * Pending message queue disabled temporarily for UI testing.
 *
 * This prevents repeated encryption/decryption retry loops while the E2EE
 * identity recovery flow is being repaired.
 */
import type { PendingEnvelope } from './types';

class PendingQueue {
  private items = new Map<string, PendingEnvelope>();

  setRetryHandler(_fn: (envelope: unknown) => Promise<boolean>) {
    console.warn('[TEST] E2EE pending queue disabled');
  }

  kick(): void {
    console.warn('[TEST] E2EE pending queue kick ignored');
  }

  enqueue(envelopeId: string, envelope: unknown): void {
    console.warn('[TEST] E2EE envelope ignored', envelopeId);
    this.items.set(envelopeId, envelope as PendingEnvelope);
  }

  refresh(envelopeId: string, envelope: unknown): void {
    console.warn('[TEST] E2EE envelope refresh ignored', envelopeId);
    this.items.set(envelopeId, envelope as PendingEnvelope);
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
  }
}

export const pendingMessageQueue = new PendingQueue();

export function processPendingMessages(): void {
  pendingMessageQueue.kick();
}
