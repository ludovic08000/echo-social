const OPTIMISTIC_UNBOUND_TTL_MS = 30_000;

interface CacheEntry {
  body: string | null;
  plaintext: string;
  touchedAt: number;
}

/**
 * Synchronous LRU used by the conversation renderer.
 *
 * A message id alone is not a safe durable cache key: edits, refan-out and
 * encrypted recovery can replace an envelope while preserving the parent id.
 * Exact body equality is therefore required for normal reads. A freshly sent
 * optimistic plaintext may temporarily be unbound because the queue receives
 * the server id before React receives the final ciphertext; that exception is
 * bounded to 30 seconds and is replaced by a body-bound entry on first resolve.
 */
export class CiphertextBoundPlaintextCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly capacity = 2_000) {}

  get(messageId: string, body?: string): string | undefined {
    const entry = this.entries.get(messageId);
    if (!entry) return undefined;

    if (body !== undefined && entry.body !== body) {
      const optimisticStillFresh =
        entry.body === null && Date.now() - entry.touchedAt <= OPTIMISTIC_UNBOUND_TTL_MS;
      if (!optimisticStillFresh) {
        if (entry.body === null) this.entries.delete(messageId);
        return undefined;
      }
    }

    this.entries.delete(messageId);
    this.entries.set(messageId, { ...entry, touchedAt: Date.now() });
    return entry.plaintext;
  }

  set(messageId: string, plaintext: string, body?: string): void {
    if (!messageId || !plaintext) return;
    this.entries.delete(messageId);
    this.entries.set(messageId, {
      body: body ?? null,
      plaintext,
      touchedAt: Date.now(),
    });
    this.trim();
  }

  has(messageId: string, body?: string): boolean {
    return this.get(messageId, body) !== undefined;
  }

  delete(messageId: string): boolean {
    return this.entries.delete(messageId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  *[Symbol.iterator](): IterableIterator<[string, string]> {
    for (const [messageId, entry] of this.entries) {
      yield [messageId, entry.plaintext];
    }
  }

  private trim(): void {
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}

export const __test__ = {
  optimisticTtlMs: OPTIMISTIC_UNBOUND_TTL_MS,
  entryBody(cache: CiphertextBoundPlaintextCache, messageId: string): string | null | undefined {
    return (cache as any).entries.get(messageId)?.body;
  },
};
