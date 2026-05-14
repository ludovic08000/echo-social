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

import { reqToPromise, runTxOn } from './indexedDbTx';

const STORE_MESSAGES = 'messages';
const STORE_KEYS = 'device-keys';
const DEVICE_KEY_ID = 'plaintext-cache-key-v1';

let cachedDeviceKey: CryptoKey | null = null;
let cachedKeyPromise: Promise<CryptoKey> | null = null;
const VOLATILE_CACHE_CAP = 500;
const volatilePlaintexts = new Map<string, string>();

function setVolatile(id: string, plaintext: string): void {
  if (!id || !plaintext) return;
  if (volatilePlaintexts.has(id)) volatilePlaintexts.delete(id);
  volatilePlaintexts.set(id, plaintext);
  while (volatilePlaintexts.size > VOLATILE_CACHE_CAP) {
    const oldest = volatilePlaintexts.keys().next().value;
    if (oldest === undefined) break;
    volatilePlaintexts.delete(oldest);
  }
}

async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  if (cachedDeviceKey) return cachedDeviceKey;
  if (cachedKeyPromise) return cachedKeyPromise;

  cachedKeyPromise = (async () => {
    const existing = await runTxOn('plaintext-cache', STORE_KEYS, 'readonly', (store) =>
      reqToPromise<{ id: string; key: CryptoKey } | undefined>(store.get(DEVICE_KEY_ID)),
    );

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

    await runTxOn('plaintext-cache', STORE_KEYS, 'readwrite', (store) => {
      store.put({ id: DEVICE_KEY_ID, key });
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

export async function rememberPlaintextForRefanout(
  plaintext: string,
  opts: { messageId?: string; ciphertextBody?: string },
): Promise<void> {
  if (!plaintext) return;
  if (opts.messageId) setVolatile(`msg:${opts.messageId}`, plaintext);
  if (opts.ciphertextBody) setVolatile(await toCiphertextLookupKey(opts.ciphertextBody), plaintext);
}

export async function loadVolatilePlaintext(messageId: string): Promise<string | null> {
  if (!messageId) return null;
  return volatilePlaintexts.get(`msg:${messageId}`) ?? null;
}

export async function loadVolatilePlaintextForCiphertext(ciphertextBody: string): Promise<string | null> {
  if (!ciphertextBody) return null;
  return volatilePlaintexts.get(await toCiphertextLookupKey(ciphertextBody)) ?? null;
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
  await runTxOn('plaintext-cache', STORE_MESSAGES, 'readwrite', (store) => {
    store.put({
      id,
      iv: iv.buffer,
      ct,
      ts: Date.now(),
    } satisfies StoredEntry);
  });
}

async function loadEntry(id: string): Promise<string | null> {
  if (!id) return null;
  const entry = await runTxOn('plaintext-cache', STORE_MESSAGES, 'readonly', (store) =>
    reqToPromise<StoredEntry | undefined>(store.get(id)),
  );
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
    const entries = await runTxOn('plaintext-cache', STORE_MESSAGES, 'readonly', (store) =>
      reqToPromise<StoredEntry[]>(store.getAll()),
    );

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
  try {
    await saveEntry(messageId, plaintext);
  } catch (e) {
    console.warn('[plaintextStore] savePlaintext failed', e);
  }
}

export async function savePlaintextForCiphertext(ciphertextBody: string, plaintext: string): Promise<void> {
  if (!ciphertextBody || !plaintext) return;
  try {
    await saveEntry(await toCiphertextLookupKey(ciphertextBody), plaintext);
  } catch (e) {
    console.warn('[plaintextStore] savePlaintextForCiphertext failed', e);
  }
}

/**
 * Load plaintext for a message id. Returns null if not found or device key
 * is unavailable.
 */
export async function loadPlaintext(messageId: string): Promise<string | null> {
  if (!messageId) return null;
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
    return await loadEntry(await toCiphertextLookupKey(ciphertextBody));
  } catch (e) {
    console.warn('[plaintextStore] loadPlaintextForCiphertext failed', e);
    return null;
  }
}

/**
 * Remove a plaintext entry (e.g. when the user deletes a message for me).
 */
export async function removePlaintext(messageId: string): Promise<void> {
  try {
    await runTxOn('plaintext-cache', STORE_MESSAGES, 'readwrite', (store) => {
      store.delete(messageId);
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
    await runTxOn('plaintext-cache', [STORE_MESSAGES, STORE_KEYS], 'readwrite', (stores) => {
      stores[STORE_MESSAGES].clear();
      stores[STORE_KEYS].clear();
    });
    volatilePlaintexts.clear();
    cachedDeviceKey = null;
    cachedKeyPromise = null;
  } catch (e) {
    console.warn('[plaintextStore] wipe failed', e);
  }
}
