/**
 * Per-message media key cache.
 *
 * `DecryptedMessageBody` decrypts the message body once and, when the plaintext
 * is a media envelope, stores the extracted media key here. `MessageMedia`
 * checks this cache first to avoid a second decrypt() call on the same body.
 *
 * Keyed by message id. Bounded — entries are evicted when the cache exceeds
 * MAX_ENTRIES to avoid unbounded growth on long sessions.
 */

const MAX_ENTRIES = 500;

interface Entry {
  mediaKeyB64: string;
  isVideo: boolean;
}

const store = new Map<string, Entry>();

export function setMediaKey(messageId: string, mediaKeyB64: string, isVideo: boolean): void {
  if (store.size >= MAX_ENTRIES) {
    const firstKey = store.keys().next().value;
    if (firstKey) store.delete(firstKey);
  }
  store.set(messageId, { mediaKeyB64, isVideo });
}

export function getMediaKey(messageId: string): Entry | undefined {
  return store.get(messageId);
}

export function clearMediaKey(messageId: string): void {
  store.delete(messageId);
}
