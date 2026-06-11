/**
 * LRU cache of decrypted media object URLs, keyed by encrypted R2 URL.
 *
 * Why: scrolling through a chat re-mounts <EncryptedMedia/> instances. Without
 * a cache, every remount triggers another R2 download + AES-GCM decrypt, which
 * is what makes photos feel slow to (re)appear. With this cache, a media that
 * was decrypted once shows instantly forever after.
 *
 * Memory: we cap entries and revoke the oldest object URL when evicted.
 */

const MAX_ENTRIES = 80;

interface Entry {
  objectUrl: string;
  isVideo: boolean;
}

const store = new Map<string, Entry>();

export function getDecryptedMedia(encryptedUrl: string): Entry | undefined {
  const entry = store.get(encryptedUrl);
  if (!entry) return undefined;
  // Touch — move to most-recently-used
  store.delete(encryptedUrl);
  store.set(encryptedUrl, entry);
  return entry;
}

export function rememberDecryptedMedia(encryptedUrl: string, objectUrl: string, isVideo: boolean): void {
  if (store.has(encryptedUrl)) return;
  if (store.size >= MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    if (oldestKey) {
      const old = store.get(oldestKey);
      store.delete(oldestKey);
      if (old) {
        try { URL.revokeObjectURL(old.objectUrl); } catch { /* noop */ }
      }
    }
  }
  store.set(encryptedUrl, { objectUrl, isVideo });
}

export function clearDecryptedMediaCache(): void {
  for (const entry of store.values()) {
    try { URL.revokeObjectURL(entry.objectUrl); } catch { /* noop */ }
  }
  store.clear();
}
