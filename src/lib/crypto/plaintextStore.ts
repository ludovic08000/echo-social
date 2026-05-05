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

export interface PlaintextCacheExportEntry {
  id: string;
  plaintext: string;
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function toCiphertextLookupKey(ciphertextBody: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ciphertextBody));
  return `cipher:${bufferToHex(digest)}`;
}

/**
 * Short-term sessionStorage mirror — survives soft reloads even when iOS
 * Safari ITP wipes IndexedDB (the encrypted store above). Bounded to 24h
 * and ~200 entries to keep memory pressure low. Plaintext stays local —
 * the server never sees it.
 */
const SESSION_MIRROR_KEY = 'forsure-pt-mirror-v1';
const SESSION_MIRROR_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_MIRROR_CAP = 200;

interface SessionMirrorEntry { p: string; t: number }

function readSessionMirror(): Record<string, SessionMirrorEntry> {
  try {
    const raw = sessionStorage.getItem(SESSION_MIRROR_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, SessionMirrorEntry>;
  } catch { return {}; }
}

function writeSessionMirror(map: Record<string, SessionMirrorEntry>) {
  try {
    const cutoff = Date.now() - SESSION_MIRROR_TTL_MS;
    const entries = Object.entries(map)
      .filter(([, v]) => v.t > cutoff)
      .sort(([, a], [, b]) => b.t - a.t)
      .slice(0, SESSION_MIRROR_CAP);
    sessionStorage.setItem(SESSION_MIRROR_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function mirrorSet(id: string, plaintext: string) {
  if (typeof sessionStorage === 'undefined') return;
  const map = readSessionMirror();
  map[id] = { p: plaintext, t: Date.now() };
  writeSessionMirror(map);
}

function mirrorGet(id: string): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  const map = readSessionMirror();
  const entry = map[id];
  if (!entry) return null;
  if (Date.now() - entry.t > SESSION_MIRROR_TTL_MS) return null;
  return entry.p;
}

async function saveEntry(id: string, plaintext: string): Promise<void> {
  if (!id || !plaintext) return;
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
      id,
      iv: iv.buffer,
      ct,
      ts: Date.now(),
    } satisfies StoredEntry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadEntry(id: string): Promise<string | null> {
  if (!id) return null;
  const db = await openDB();
  const entry = await new Promise<StoredEntry | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_MESSAGES, 'readonly');
    const req = tx.objectStore(STORE_MESSAGES).get(id);
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
}

export async function exportPlaintextCache(): Promise<PlaintextCacheExportEntry[]> {
  try {
    const db = await openDB();
    const entries = await new Promise<StoredEntry[]>((resolve, reject) => {
      const tx = db.transaction(STORE_MESSAGES, 'readonly');
      const req = tx.objectStore(STORE_MESSAGES).getAll();
      req.onsuccess = () => resolve(req.result as StoredEntry[]);
      req.onerror = () => reject(req.error);
    });

    const exported: PlaintextCacheExportEntry[] = [];
    for (const entry of entries) {
      try {
        const plaintext = await loadEntry(entry.id);
        if (plaintext) exported.push({ id: entry.id, plaintext });
      } catch {
        // Skip entries that belong to a stale local cache key.
      }
    }
    return exported;
  } catch (e) {
    console.warn('[plaintextStore] exportPlaintextCache failed', e);
    return [];
  }
}

export async function importPlaintextCache(entries: PlaintextCacheExportEntry[]): Promise<void> {
  if (!Array.isArray(entries) || entries.length === 0) return;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.plaintext !== 'string') continue;
    await saveEntry(entry.id, entry.plaintext);
  }
}

/**
 * Save plaintext for a message id (server id). Idempotent.
 */
export async function savePlaintext(messageId: string, plaintext: string): Promise<void> {
  if (!messageId || !plaintext) return;
  mirrorSet(messageId, plaintext);
  try {
    await saveEntry(messageId, plaintext);
  } catch (e) {
    console.warn('[plaintextStore] savePlaintext failed', e);
  }
}

export async function savePlaintextForCiphertext(ciphertextBody: string, plaintext: string): Promise<void> {
  if (!ciphertextBody || !plaintext) return;
  try {
    const id = await toCiphertextLookupKey(ciphertextBody);
    mirrorSet(id, plaintext);
    await saveEntry(id, plaintext);
  } catch (e) {
    console.warn('[plaintextStore] savePlaintextForCiphertext failed', e);
  }
}

export async function loadPlaintext(messageId: string): Promise<string | null> {
  if (!messageId) return null;
  const mirror = mirrorGet(messageId);
  if (mirror !== null) return mirror;
  try {
    return await loadEntry(messageId);
  } catch (e) {
    console.warn('[plaintextStore] loadPlaintext failed', e);
    return null;
  }
}

export async function loadPlaintextForCiphertext(ciphertextBody: string): Promise<string | null> {
  if (!ciphertextBody) return null;
  try {
    const id = await toCiphertextLookupKey(ciphertextBody);
    const mirror = mirrorGet(id);
    if (mirror !== null) return mirror;
    return await loadEntry(id);
  } catch (e) {
    console.warn('[plaintextStore] loadPlaintextForCiphertext failed', e);
    return null;
  }
}

export async function removePlaintext(messageId: string): Promise<void> {
  try {
    const map = readSessionMirror();
    if (map[messageId]) { delete map[messageId]; writeSessionMirror(map); }
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
