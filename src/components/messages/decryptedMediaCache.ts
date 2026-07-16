/**
 * LRU cache of decrypted media object URLs, keyed by encrypted URL + media key.
 * Mounted media retain their exact entry. Retiring a cache entry never revokes
 * an object URL until its final mounted consumer releases it.
 */

const MAX_ENTRIES = 80;

export interface DecryptedMediaEntry {
  objectUrl: string;
  isVideo: boolean;
  refs: number;
  retired?: boolean;
  revoked?: boolean;
}

type Listener = (entry: DecryptedMediaEntry) => void;

const store = new Map<string, DecryptedMediaEntry>();
const listeners = new Map<string, Set<Listener>>();
const cloneInflight = new Map<string, Promise<void>>();

function revokeEntry(entry: DecryptedMediaEntry): void {
  if (entry.revoked) return;
  entry.revoked = true;
  try { URL.revokeObjectURL(entry.objectUrl); } catch { /* noop */ }
}

function touch(cacheKey: string, entry: DecryptedMediaEntry): void {
  store.delete(cacheKey);
  store.set(cacheKey, entry);
}

function notify(cacheKey: string, entry: DecryptedMediaEntry): void {
  listeners.get(cacheKey)?.forEach(listener => {
    try { listener(entry); } catch { /* noop */ }
  });
}

function retireEntry(entry: DecryptedMediaEntry): void {
  entry.retired = true;
  if (entry.refs === 0) revokeEntry(entry);
}

function trim(): void {
  if (store.size <= MAX_ENTRIES) return;
  for (const [key, entry] of store) {
    if (store.size <= MAX_ENTRIES) break;
    if (entry.refs > 0) continue;
    store.delete(key);
    cloneInflight.delete(key);
    retireEntry(entry);
  }
}

async function cloneTransientObjectUrl(
  cacheKey: string,
  sourceUrl: string,
  isVideo: boolean,
): Promise<void> {
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) return;
    const blob = await response.blob();
    const clonedUrl = URL.createObjectURL(blob);
    const current = store.get(cacheKey);
    if (!current || current.objectUrl !== sourceUrl) {
      try { URL.revokeObjectURL(clonedUrl); } catch { /* noop */ }
      return;
    }

    const replacement: DecryptedMediaEntry = {
      objectUrl: clonedUrl,
      isVideo,
      refs: current.refs,
    };
    current.retired = true;
    // The transient source URL belongs to the upload placeholder and is revoked
    // by its owner, so the cache must not revoke it here.
    touch(cacheKey, replacement);
    notify(cacheKey, replacement);
  } catch {
    // EncryptedMedia falls back to downloading/decrypting the encrypted object.
  } finally {
    cloneInflight.delete(cacheKey);
  }
}

export function getDecryptedMedia(cacheKey: string): DecryptedMediaEntry | undefined {
  const entry = store.get(cacheKey);
  if (!entry || entry.revoked) return undefined;
  touch(cacheKey, entry);
  return entry;
}

export function rememberDecryptedMedia(
  cacheKey: string,
  objectUrl: string,
  isVideo: boolean,
  transient = true,
): void {
  const existing = store.get(cacheKey);
  if (existing && !existing.revoked) {
    touch(cacheKey, existing);
    if (existing.objectUrl !== objectUrl && !transient) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* noop */ }
    }
    return;
  }

  const entry: DecryptedMediaEntry = { objectUrl, isVideo, refs: 0 };
  store.set(cacheKey, entry);
  trim();

  if (transient && objectUrl.startsWith('blob:') && !cloneInflight.has(cacheKey)) {
    const task = cloneTransientObjectUrl(cacheKey, objectUrl, isVideo);
    cloneInflight.set(cacheKey, task);
  }
}

export function subscribeDecryptedMedia(
  cacheKey: string,
  listener: Listener,
): () => void {
  let set = listeners.get(cacheKey);
  if (!set) {
    set = new Set();
    listeners.set(cacheKey, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(cacheKey);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(cacheKey);
  };
}

/** Retain the exact entry and return a release closure bound to that entry. */
export function retainDecryptedMedia(cacheKey: string): (() => void) | undefined {
  const entry = store.get(cacheKey);
  if (!entry || entry.revoked) return undefined;
  entry.refs += 1;
  touch(cacheKey, entry);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.retired && entry.refs === 0) revokeEntry(entry);
    trim();
  };
}

/** Backward-compatible release for call sites that do not retain closures. */
export function releaseDecryptedMedia(cacheKey: string): void {
  const entry = store.get(cacheKey);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.retired && entry.refs === 0) revokeEntry(entry);
  trim();
}

/** Retire one stale/dead URL without breaking another mounted consumer. */
export function forgetDecryptedMedia(cacheKey: string): void {
  const entry = store.get(cacheKey);
  if (!entry) return;
  store.delete(cacheKey);
  cloneInflight.delete(cacheKey);
  retireEntry(entry);
}

export function clearDecryptedMediaCache(): void {
  for (const entry of store.values()) retireEntry(entry);
  store.clear();
  cloneInflight.clear();
}

export const __test__ = { trim, cloneTransientObjectUrl };
