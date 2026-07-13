/**
 * LRU cache of decrypted media object URLs, keyed by encrypted R2 URL.
 *
 * Mounted media retain their object URL. Transient local preview URLs are
 * cloned before their owner revokes them, so the delivered bubble never keeps
 * a dead `blob:` URL.
 */

const MAX_ENTRIES = 80;

export interface DecryptedMediaEntry {
  objectUrl: string;
  isVideo: boolean;
  refs: number;
}

type Listener = (entry: DecryptedMediaEntry) => void;

const store = new Map<string, DecryptedMediaEntry>();
const listeners = new Map<string, Set<Listener>>();
const cloneInflight = new Map<string, Promise<void>>();

function touch(encryptedUrl: string, entry: DecryptedMediaEntry): void {
  store.delete(encryptedUrl);
  store.set(encryptedUrl, entry);
}

function notify(encryptedUrl: string, entry: DecryptedMediaEntry): void {
  listeners.get(encryptedUrl)?.forEach((listener) => {
    try { listener(entry); } catch { /* noop */ }
  });
}

function trim(): void {
  if (store.size <= MAX_ENTRIES) return;

  for (const [key, entry] of store) {
    if (store.size <= MAX_ENTRIES) break;
    if (entry.refs > 0) continue;
    store.delete(key);
    cloneInflight.delete(key);
    try { URL.revokeObjectURL(entry.objectUrl); } catch { /* noop */ }
  }
}

async function cloneTransientObjectUrl(
  encryptedUrl: string,
  sourceUrl: string,
  isVideo: boolean,
): Promise<void> {
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) return;
    const blob = await response.blob();
    const clonedUrl = URL.createObjectURL(blob);
    const current = store.get(encryptedUrl);

    if (!current || current.objectUrl !== sourceUrl) {
      try { URL.revokeObjectURL(clonedUrl); } catch { /* noop */ }
      return;
    }

    const replacement: DecryptedMediaEntry = {
      objectUrl: clonedUrl,
      isVideo,
      refs: current.refs,
    };
    touch(encryptedUrl, replacement);
    notify(encryptedUrl, replacement);
    // sourceUrl belongs to the upload placeholder and is revoked by its owner.
  } catch {
    // EncryptedMedia will fall back to downloading/decrypting the R2 object.
  } finally {
    cloneInflight.delete(encryptedUrl);
  }
}

export function getDecryptedMedia(encryptedUrl: string): DecryptedMediaEntry | undefined {
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
    if (existing.objectUrl !== objectUrl && !objectUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(objectUrl); } catch { /* noop */ }
    }
    return;
  }

  const entry: DecryptedMediaEntry = { objectUrl, isVideo, refs: 0 };
  store.set(encryptedUrl, entry);
  trim();

  if (objectUrl.startsWith('blob:') && !cloneInflight.has(encryptedUrl)) {
    const task = cloneTransientObjectUrl(encryptedUrl, objectUrl, isVideo);
    cloneInflight.set(encryptedUrl, task);
  }
}

export function subscribeDecryptedMedia(
  encryptedUrl: string,
  listener: Listener,
): () => void {
  let set = listeners.get(encryptedUrl);
  if (!set) {
    set = new Set();
    listeners.set(encryptedUrl, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(encryptedUrl);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(encryptedUrl);
  };
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
  cloneInflight.delete(encryptedUrl);
  try { URL.revokeObjectURL(entry.objectUrl); } catch { /* noop */ }
}

export function clearDecryptedMediaCache(): void {
  for (const entry of store.values()) {
    try { URL.revokeObjectURL(entry.objectUrl); } catch { /* noop */ }
  }
  store.clear();
  cloneInflight.clear();
}

export const __test__ = { trim, cloneTransientObjectUrl };
