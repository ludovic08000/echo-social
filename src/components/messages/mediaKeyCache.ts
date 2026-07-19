/**
 * Per-message media key cache.
 *
 * Key eviction must never delete a live subscriber. A mounted media bubble may
 * still be waiting for a refreshed key after cache pressure.
 */

const MAX_ENTRIES = 500;

interface Entry {
  mediaKeyB64: string;
  isVideo: boolean;
}

const store = new Map<string, Entry>();
const listeners = new Map<string, Set<(entry: Entry) => void>>();

function touch(messageId: string, entry: Entry): void {
  store.delete(messageId);
  store.set(messageId, entry);
}

function evictOneUnsubscribed(): void {
  for (const [messageId] of store) {
    if ((listeners.get(messageId)?.size ?? 0) > 0) continue;
    store.delete(messageId);
    return;
  }
  // Every cached key is currently observed. Temporarily exceed the cap rather
  // than disconnecting a mounted bubble from future key updates.
}

export function setMediaKey(messageId: string, mediaKeyB64: string, isVideo: boolean): void {
  const existing = store.get(messageId);
  if (existing?.mediaKeyB64 === mediaKeyB64 && existing.isVideo === isVideo) {
    touch(messageId, existing);
    return;
  }
  if (!existing && store.size >= MAX_ENTRIES) evictOneUnsubscribed();

  const entry: Entry = { mediaKeyB64, isVideo };
  touch(messageId, entry);
  const subscribers = listeners.get(messageId);
  if (subscribers) {
    subscribers.forEach((notify) => {
      try { notify(entry); } catch { /* noop */ }
    });
  }
}

export function getMediaKey(messageId: string): Entry | undefined {
  const entry = store.get(messageId);
  if (entry) touch(messageId, entry);
  return entry;
}

export function clearMediaKey(messageId: string): void {
  store.delete(messageId);
  // Explicit clearing of a key is not a reason to detach a mounted subscriber.
}

export function subscribeMediaKey(messageId: string, notify: (entry: Entry) => void): () => void {
  let set = listeners.get(messageId);
  if (!set) {
    set = new Set();
    listeners.set(messageId, set);
  }
  set.add(notify);
  return () => {
    const current = listeners.get(messageId);
    if (!current) return;
    current.delete(notify);
    if (current.size === 0) listeners.delete(messageId);
  };
}
