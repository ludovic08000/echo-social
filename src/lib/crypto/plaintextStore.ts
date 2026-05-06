/**
 * Persistent plaintext cache for messages — hardened IndexedDB version.
 *
 * This file is intentionally defensive: Chrome/Vite hot reload, browser tab
 * suspension, and IndexedDB version changes can close a database connection
 * while async React code is still trying to read it. In that case we reset the
 * cached connection and return a safe null/empty result instead of spamming the
 * console or crashing the UI.
 */

const DB_NAME = 'forsure-plaintext-cache';
const DB_VERSION = 1;
const STORE_MESSAGES = 'messages';
const STORE_KEYS = 'device-keys';
const DEVICE_KEY_ID = 'plaintext-cache-key-v1';

let dbPromise: Promise<IDBDatabase> | null = null;
let cachedDeviceKey: CryptoKey | null = null;
let cachedKeyPromise: Promise<CryptoKey> | null = null;
let lastIndexedDbWarningAt = 0;

export interface PlaintextCacheExportEntry {
  id: string;
  plaintext: string;
}

interface StoredEntry {
  id: string;
  iv: ArrayBuffer;
  ct: ArrayBuffer;
  ts: number;
}

function isIDBClosedError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'InvalidStateError' || error.name === 'TransactionInactiveError')
  ) || String(error).includes('database connection is closing');
}

function warnOnce(message: string, error?: unknown) {
  const now = Date.now();
  if (now - lastIndexedDbWarningAt < 5000) return;
  lastIndexedDbWarningAt = now;
  console.warn(message, error);
}

function resetDBConnection() {
  dbPromise = null;
  cachedKeyPromise = null;
}

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

    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        resetDBConnection();
      };
      db.onclose = () => resetDBConnection();
      db.onerror = () => resetDBConnection();
      resolve(db);
    };

    req.onerror = () => {
      resetDBConnection();
      reject(req.error);
    };

    req.onblocked = () => {
      resetDBConnection();
      reject(new Error('IndexedDB open blocked'));
    };
  });

  return dbPromise;
}

async function withStore<T>(
  storeName: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
  fallback: T,
): Promise<T> {
  try {
    const db = await openDB();
    const tx = db.transaction(storeName, mode);
    return await fn(tx);
  } catch (error) {
    if (isIDBClosedError(error)) {
      resetDBConnection();
      warnOnce('[plaintextStore] IndexedDB connection was closing; operation skipped safely', error);
      return fallback;
    }
    throw error;
  }
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

function reqResult<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  if (cachedDeviceKey) return cachedDeviceKey;
  if (cachedKeyPromise) return cachedKeyPromise;

  cachedKeyPromise = (async () => {
    const existing = await withStore<{ id: string; key: CryptoKey } | undefined>(
      STORE_KEYS,
      'readonly',
      async (tx) => reqResult(tx.objectStore(STORE_KEYS).get(DEVICE_KEY_ID)),
      undefined,
    );

    if (existing?.key) {
      cachedDeviceKey = existing.key;
      return existing.key;
    }

    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

    await withStore<void>(
      STORE_KEYS,
      'readwrite',
      async (tx) => {
        tx.objectStore(STORE_KEYS).put({ id: DEVICE_KEY_ID, key });
        await txDone(tx);
      },
      undefined,
    );

    cachedDeviceKey = key;
    return key;
  })().catch((error) => {
    cachedKeyPromise = null;
    throw error;
  });

  return cachedKeyPromise;
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

const SESSION_MIRROR_KEY = 'forsure-pt-mirror-v1';
const SESSION_MIRROR_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_MIRROR_CAP = 200;

interface SessionMirrorEntry { p: string; t: number }

function readSessionMirror(): Record<string, SessionMirrorEntry> {
  try {
    if (typeof sessionStorage === 'undefined') return {};
    const raw = sessionStorage.getItem(SESSION_MIRROR_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, SessionMirrorEntry>;
  } catch {
    return {};
  }
}

function writeSessionMirror(map: Record<string, SessionMirrorEntry>) {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const cutoff = Date.now() - SESSION_MIRROR_TTL_MS;
    const entries = Object.entries(map)
      .filter(([, value]) => value.t > cutoff)
      .sort(([, a], [, b]) => b.t - a.t)
      .slice(0, SESSION_MIRROR_CAP);
    sessionStorage.setItem(SESSION_MIRROR_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function mirrorSet(id: string, plaintext: string) {
  const map = readSessionMirror();
  map[id] = { p: plaintext, t: Date.now() };
  writeSessionMirror(map);
}

function mirrorGet(id: string): string | null {
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

  await withStore<void>(
    STORE_MESSAGES,
    'readwrite',
    async (tx) => {
      tx.objectStore(STORE_MESSAGES).put({ id, iv: iv.buffer, ct, ts: Date.now() } satisfies StoredEntry);
      await txDone(tx);
    },
    undefined,
  );
}

async function loadEntry(id: string): Promise<string | null> {
  if (!id) return null;

  const entry = await withStore<StoredEntry | undefined>(
    STORE_MESSAGES,
    'readonly',
    async (tx) => reqResult(tx.objectStore(STORE_MESSAGES).get(id)),
    undefined,
  );

  if (!entry) return null;

  try {
    const key = await getOrCreateDeviceKey();
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: entry.iv }, key, entry.ct);
    return new TextDecoder().decode(pt);
  } catch (error) {
    if (isIDBClosedError(error)) {
      resetDBConnection();
      return null;
    }
    // Cache entry may belong to a stale local key. Ignore safely.
    return null;
  }
}

export async function exportPlaintextCache(): Promise<PlaintextCacheExportEntry[]> {
  try {
    const entries = await withStore<StoredEntry[]>(
      STORE_MESSAGES,
      'readonly',
      async (tx) => reqResult(tx.objectStore(STORE_MESSAGES).getAll() as IDBRequest<StoredEntry[]>),
      [],
    );

    const exported: PlaintextCacheExportEntry[] = [];
    for (const entry of entries) {
      const plaintext = await loadEntry(entry.id);
      if (plaintext) exported.push({ id: entry.id, plaintext });
    }
    return exported;
  } catch (error) {
    warnOnce('[plaintextStore] exportPlaintextCache failed', error);
    return [];
  }
}

export async function importPlaintextCache(entries: PlaintextCacheExportEntry[]): Promise<void> {
  if (!Array.isArray(entries) || entries.length === 0) return;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.plaintext !== 'string') continue;
    try {
      await saveEntry(entry.id, entry.plaintext);
    } catch (error) {
      warnOnce('[plaintextStore] import entry skipped', error);
    }
  }
}

export async function savePlaintext(messageId: string, plaintext: string): Promise<void> {
  if (!messageId || !plaintext) return;
  mirrorSet(messageId, plaintext);
  try {
    await saveEntry(messageId, plaintext);
  } catch (error) {
    if (isIDBClosedError(error)) resetDBConnection();
    warnOnce('[plaintextStore] savePlaintext skipped safely', error);
  }
}

export async function savePlaintextForCiphertext(ciphertextBody: string, plaintext: string): Promise<void> {
  if (!ciphertextBody || !plaintext) return;
  try {
    const id = await toCiphertextLookupKey(ciphertextBody);
    mirrorSet(id, plaintext);
    await saveEntry(id, plaintext);
  } catch (error) {
    if (isIDBClosedError(error)) resetDBConnection();
    warnOnce('[plaintextStore] savePlaintextForCiphertext skipped safely', error);
  }
}

export async function loadPlaintext(messageId: string): Promise<string | null> {
  if (!messageId) return null;
  const mirror = mirrorGet(messageId);
  if (mirror !== null) return mirror;
  try {
    return await loadEntry(messageId);
  } catch (error) {
    if (isIDBClosedError(error)) resetDBConnection();
    warnOnce('[plaintextStore] loadPlaintext skipped safely', error);
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
  } catch (error) {
    if (isIDBClosedError(error)) resetDBConnection();
    warnOnce('[plaintextStore] loadPlaintextForCiphertext skipped safely', error);
    return null;
  }
}

export async function removePlaintext(messageId: string): Promise<void> {
  try {
    const map = readSessionMirror();
    if (map[messageId]) {
      delete map[messageId];
      writeSessionMirror(map);
    }

    await withStore<void>(
      STORE_MESSAGES,
      'readwrite',
      async (tx) => {
        tx.objectStore(STORE_MESSAGES).delete(messageId);
        await txDone(tx);
      },
      undefined,
    );
  } catch (error) {
    if (isIDBClosedError(error)) resetDBConnection();
    warnOnce('[plaintextStore] removePlaintext skipped safely', error);
  }
}

export async function wipePlaintextStore(): Promise<void> {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SESSION_MIRROR_KEY);
  } catch {}

  try {
    await withStore<void>(
      [STORE_MESSAGES, STORE_KEYS],
      'readwrite',
      async (tx) => {
        tx.objectStore(STORE_MESSAGES).clear();
        tx.objectStore(STORE_KEYS).clear();
        await txDone(tx);
      },
      undefined,
    );
    cachedDeviceKey = null;
    cachedKeyPromise = null;
  } catch (error) {
    if (isIDBClosedError(error)) resetDBConnection();
    warnOnce('[plaintextStore] wipe skipped safely', error);
  }
}
