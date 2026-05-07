/**
 * Bounded LRU Map (insertion-order eviction).
 * Drop-in replacement for Map for the few methods we use across the app:
 *   - get / set / has / delete / size / [Symbol.iterator]
 *
 * On `get`, the entry is promoted to the most-recently-used position so the
 * eviction policy is true LRU (not just FIFO). On `set`, when the map exceeds
 * `maxEntries`, the oldest entry is evicted.
 *
 * Used by:
 *   - ChatView decrypted plaintext cache (prevents unbounded RAM growth in
 *     long sessions or when scrolling huge conversations).
 */
export class LRUMap<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly maxEntries: number) {
    if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
      throw new Error('LRUMap: maxEntries must be a positive finite number');
    }
  }

  get size(): number {
    return this.map.size;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key) as V;
    // Promote to most-recently-used.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.map[Symbol.iterator]();
  }

  keys() {
    return this.map.keys();
  }

  values() {
    return this.map.values();
  }

  entries() {
    return this.map.entries();
  }
}
