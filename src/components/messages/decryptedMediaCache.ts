/**
 * LRU cache of decrypted media object URLs, keyed by encrypted R2 URL.
 *
 * Mounted media retain their object URL. Eviction only revokes unmounted
 * entries; otherwise a still-visible image/video can suddenly turn blank when
 * the cache crosses its cap.
 */

const MAX_ENTRIES = 80;

interface Entry {
  objectUrl: string;
  isVideo: boolean;
  refs: number;
}

const store = new Map<string, Entry>();

function touch(encryptedUrl: string, entry: Entry): void {
  store.delete(encryptedUrl);
  store.set(encryptedUrl, entry);
}

function trim(): void {
  if (store.size <= MAX_ENTRIES) return;

  for (const [key, entry] of store) {
    if (store.size <= MAX_ENTRIES) break;
    if (entry.refs > 0) continue;
    store.delete(key);
    try { URL.revokeObjectURL(entry.objectUrl); } catch { /* noop */ }
  }
}

export function getDecryptedMedia(encryptedUrl: string): Entry | undefined {
  const entry = store.get(encryptedUrl);
  if (!entry) return undefined;
  touch(encryptedUrl, entry);
  return entry;
}

export function rememberDecryptedMedia(
  encryptedUrl: string,
  objectUrl: string,
  isVideo: boolean,
): void {
  const existing = store.get(encryptedUrl);
  if (existing) {
    touch(encryptedUrl, existing);
    if (existing.objectUrl !== objectUrl) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* noop */ }
    }
    return;
  }

  store.set(encryptedUrl, { objectUrl, isVideo, refs: 0 });
  trim();
}

export function retainDecryptedMedia(encryptedUrl: string): void {
  const entry = store.get(encryptedUrl);
  if (!entry) return;
  entry.refs += 1;
  touch(encryptedUrl, entry);
}

export function releaseDecryptedMedia(encryptedUrl: string): void {
  const entry = store.get(encryptedUrl);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  trim();
}

/** Remove one stale/dead object URL so the component can download again. */
export function forgetDecryptedMedia(encryptedUrl: string): void {
  const entry = store.get(encryptedUrl);
  if (!entry) return;
  store.delete(encryptedUrl);
  try { URL.revokeObjectURL(entry.objectUrl); } catch { /* noop */ }
}

export function clearDecryptedMediaCache(): void {
  for (const entry of store.values()) {
    try { URL.revokeObjectURL(entry.objectUrl); } catch { /* noop */ }
  }
  store.clear();
}

export const __test__ = { trim };
