/**
 * Per-message media key cache.
 *
 * `DecryptedMessageBody` decrypts the message body once and, when the plaintext
 * is a media envelope, stores the extracted media key here. `MessageMedia`
 * checks this cache first to avoid a second decrypt() call on the same body.
 *
 * Subscribers (MessageMedia instances) are notified the moment a key lands so
 * the image/video swaps from the "📷 Photo" placeholder to the decrypted media
 * without any polling delay.
 */

const MAX_ENTRIES = 500;

interface Entry {
  mediaKeyB64: string;
  isVideo: boolean;
}

const store = new Map<string, Entry>();
const listeners = new Map<string, Set<(entry: Entry) => void>>();

export function setMediaKey(messageId: string, mediaKeyB64: string, isVideo: boolean): void {
  if (store.size >= MAX_ENTRIES) {
    const firstKey = store.keys().next().value;
    if (firstKey) {
      store.delete(firstKey);
      listeners.delete(firstKey);
    }
  }
  const entry: Entry = { mediaKeyB64, isVideo };
  store.set(messageId, entry);
  const subs = listeners.get(messageId);
  if (subs) subs.forEach(fn => { try { fn(entry); } catch { /* noop */ } });
}

export function getMediaKey(messageId: string): Entry | undefined {
  return store.get(messageId);
}

export function clearMediaKey(messageId: string): void {
  store.delete(messageId);
  listeners.delete(messageId);
}

export function subscribeMediaKey(messageId: string, fn: (entry: Entry) => void): () => void {
  let set = listeners.get(messageId);
  if (!set) { set = new Set(); listeners.set(messageId, set); }
  set.add(fn);
  return () => {
    const s = listeners.get(messageId);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) listeners.delete(messageId);
  };
}
