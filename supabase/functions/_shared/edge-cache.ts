/**
 * In-memory edge cache with TTL.
 * Edge Functions persist memory across warm invocations on the same isolate,
 * so this provides significant savings for repeated requests.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

// Periodic cleanup every 60s
let lastCleanup = Date.now();
function maybeCleanup() {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  for (const [key, entry] of store) {
    if (entry.expiresAt < now) store.delete(key);
  }
}

/**
 * Get or set a cached value with TTL.
 * @param key Unique cache key
 * @param ttlMs Time-to-live in milliseconds
 * @param fetcher Async function to produce the value on cache miss
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  maybeCleanup();
  const now = Date.now();
  const existing = store.get(key) as CacheEntry<T> | undefined;
  if (existing && existing.expiresAt > now) {
    return existing.value;
  }
  const value = await fetcher();
  store.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

/** Invalidate a specific key */
export function invalidateCache(key: string) {
  store.delete(key);
}

/** Cache stats for monitoring */
export function getCacheStats() {
  const now = Date.now();
  let valid = 0;
  let expired = 0;
  for (const entry of store.values()) {
    if (entry.expiresAt > now) valid++;
    else expired++;
  }
  return { size: store.size, valid, expired };
}
