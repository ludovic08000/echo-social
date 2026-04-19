/**
 * Persistent plaintext cache for messages — survives reload.
 *
 * Security model:
 * - Stored in IndexedDB on the device only — NEVER sent to the server.
 * - Each entry is encrypted with a device-local AES-GCM key, kept in IndexedDB.
 * - The device key never leaves the browser. If the device is wiped or the
 *   browser data cleared, plaintexts become unrecoverable (forward secrecy
 *   on local storage).
 * - This complements (does not replace) E2EE: the server still only sees
 *   ciphertext. This cache only restores the local UX after a page reload.
 */

const DB_NAME = 'forsure-plaintext-cache';
const DB_VERSION = 1;
const STORE_MESSAGES = 'messages';
const STORE_KEYS = 'device-keys';
const DEVICE_KEY_ID = 'plaintext-cache-key-v1';

let dbPromise: Promise<IDBDatabase> | null = null;
let cachedDeviceKey: CryptoKey | null = null;
let cachedKeyPromise: Promise<CryptoKey> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        db.createObjectStore(STORE_MESSAGES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_KEYS)) {
        db.createObjectStore(STORE_KEYS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  if (cachedDeviceKey) return cachedDeviceKey;
  if (cachedKeyPromise) return cachedKeyPromise;

  cachedKeyPromise = (async () => {
    const db = await openDB();
    const existing = await new Promise<{ id: string; key: CryptoKey } | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_KEYS, 'readonly');
      const req = tx.objectStore(STORE_KEYS).get(DEVICE_KEY_ID);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    if (existing?.key) {
      cachedDeviceKey = existing.key;
      return existing.key;
    }

    // Generate a non-extractable AES-GCM key — can never be exported, even by us
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // not extractable — bound to this device
      ['encrypt', 'decrypt'],
    );

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_KEYS, 'readwrite');
      tx.objectStore(STORE_KEYS).put({ id: DEVICE_KEY_ID, key });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    cachedDeviceKey = key;
    return key;
  })();

  return cachedKeyPromise;
}

interface StoredEntry {
  id: string;          // messageId (server id) or composite key
  iv: ArrayBuffer;
  ct: ArrayBuffer;
  ts: number;
}

/**
 * Save plaintext for a message id (server id). Idempotent.
 */
export async function savePlaintext(messageId: string, plaintext: string): Promise<void> {
  if (!messageId || !plaintext) return;
  try {
    const key = await getOrCreateDeviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext),
    );
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite');
      tx.objectStore(STORE_MESSAGES).put({
        id: messageId,
        iv: iv.buffer,
        ct,
        ts: Date.now(),
      } satisfies StoredEntry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[plaintextStore] savePlaintext failed', e);
  }
}

/**
 * Load plaintext for a message id. Returns null if not found or device key
 * is unavailable.
 */
export async function loadPlaintext(messageId: string): Promise<string | null> {
  if (!messageId) return null;
  try {
    const db = await openDB();
    const entry = await new Promise<StoredEntry | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const req = tx.objectStore(STORE_MESSAGES).get(messageId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!entry) return null;
    const key = await getOrCreateDeviceKey();
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: entry.iv },
      key,
      entry.ct,
    );
    return new TextDecoder().decode(pt);
  } catch (e) {
    console.warn('[plaintextStore] loadPlaintext failed', e);
    return null;
  }
}

/**
 * Remove a plaintext entry (e.g. when the user deletes a message for me).
 */
export async function removePlaintext(messageId: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readwrite');
      tx.objectStore(STORE_MESSAGES).delete(messageId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[plaintextStore] removePlaintext failed', e);
  }
}

/**
 * Wipe everything — used on logout for hygiene.
 */
export async function wipePlaintextStore(): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_MESSAGES, STORE_KEYS], 'readwrite');
      tx.objectStore(STORE_MESSAGES).clear();
      tx.objectStore(STORE_KEYS).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    cachedDeviceKey = null;
    cachedKeyPromise = null;
  } catch (e) {
    console.warn('[plaintextStore] wipe failed', e);
  }
}
