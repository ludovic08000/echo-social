/**
 * Device-local decrypted-message cache.
 *
 * Plaintext is encrypted with a non-extractable, device-local AES key before it
 * reaches IndexedDB. It is never mirrored to Web Storage and never exported in
 * account backups. A short-lived in-memory cache avoids repeated decrypt work
 * during the current JavaScript lifetime without creating a recoverable
 * plaintext history.
 */

import { runTxOn, reqToPromise } from './indexedDbTx';

const STORE_MESSAGES = 'messages';
const STORE_KEYS = 'device-keys';
const DEVICE_KEY_ID = 'plaintext-cache-key-v1';
const MEMORY_TTL_MS = 30 * 60 * 1000;
const MEMORY_CAP = 200;

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

interface MemoryEntry {
  plaintext: string;
  ts: number;
}

const memoryMirror = new Map<string, MemoryEntry>();

function warnOnce(message: string, error?: unknown) {
  const now = Date.now();
  if (now - lastIndexedDbWarningAt < 5000) return;
  lastIndexedDbWarningAt = now;
  console.warn(message, error);
}

function pruneMemoryMirror(): void {
  const cutoff = Date.now() - MEMORY_TTL_MS;
  for (const [id, entry] of memoryMirror) {
    if (entry.ts < cutoff) memoryMirror.delete(id);
  }
  while (memoryMirror.size > MEMORY_CAP) {
    const oldest = memoryMirror.keys().next().value as string | undefined;
    if (!oldest) break;
    memoryMirror.delete(oldest);
  }
}

function mirrorSet(id: string, plaintext: string): void {
  memoryMirror.delete(id);
  memoryMirror.set(id, { plaintext, ts: Date.now() });
  pruneMemoryMirror();
}

function mirrorGet(id: string): string | null {
  const entry = memoryMirror.get(id);
  if (!entry) return null;
  if (Date.now() - entry.ts > MEMORY_TTL_MS) {
    memoryMirror.delete(id);
    return null;
  }
  return entry.plaintext;
}

async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  if (cachedDeviceKey) return cachedDeviceKey;
  if (cachedKeyPromise) return cachedKeyPromise;

  cachedKeyPromise = (async () => {
    let readOk = false;
    let existing: { id: string; key: CryptoKey } | undefined;
    let lastErr: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        existing = await runTxOn('plaintext-cache', [STORE_KEYS], 'readonly', (tx) =>
          reqToPromise(tx.objectStore(STORE_KEYS).get(DEVICE_KEY_ID) as IDBRequest<{ id: string; key: CryptoKey } | undefined>),
        );
        readOk = true;
        break;
      } catch (error) {
        lastErr = error;
        await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
      }
    }

    if (readOk && existing?.key) {
      cachedDeviceKey = existing.key;
      return existing.key;
    }

    if (!readOk) {
      throw new Error('[plaintextStore] device key read failed, refusing to regenerate: ' + String(lastErr));
    }

    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

    await runTxOn('plaintext-cache', [STORE_KEYS], 'readwrite', (tx) => {
      tx.objectStore(STORE_KEYS).put({ id: DEVICE_KEY_ID, key });
    });

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

async function saveEntry(id: string, plaintext: string): Promise<void> {
  if (!id || !plaintext) return;
  const key = await getOrCreateDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(`forsure-plaintext-cache|${id}|v2`);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    key,
    new TextEncoder().encode(plaintext),
  );

  await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readwrite', (tx) => {
    tx.objectStore(STORE_MESSAGES).put({ id, iv: iv.buffer, ct, ts: Date.now() } satisfies StoredEntry);
  });
}

async function loadEntry(id: string): Promise<string | null> {
  if (!id) return null;

  const entry = await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_MESSAGES).get(id) as IDBRequest<StoredEntry | undefined>),
  ).catch(() => undefined);

  if (!entry) return null;

  try {
    const key = await getOrCreateDeviceKey();
    const aad = new TextEncoder().encode(`forsure-plaintext-cache|${id}|v2`);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: entry.iv, additionalData: aad },
      key,
      entry.ct,
    );
    const plaintext = new TextDecoder().decode(pt);
    mirrorSet(id, plaintext);
    return plaintext;
  } catch {
    // Legacy cache entries had no AAD. They are intentionally not decrypted or
    // migrated because doing so would preserve plaintext history indefinitely.
    return null;
  }
}

/** Plaintext is deliberately excluded from all account/key backups. */
export async function exportPlaintextCache(_limit?: number): Promise<PlaintextCacheExportEntry[]> {
  return [];
}

/** Legacy backups may contain plaintext entries; ignore them on restore. */
export async function importPlaintextCache(_entries: PlaintextCacheExportEntry[]): Promise<void> {
  return;
}

export async function savePlaintext(messageId: string, plaintext: string): Promise<void> {
  if (!messageId || !plaintext) return;
  mirrorSet(messageId, plaintext);
  try {
    await saveEntry(messageId, plaintext);
  } catch (error) {
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
    warnOnce('[plaintextStore] loadPlaintextForCiphertext skipped safely', error);
    return null;
  }
}

export async function removePlaintext(messageId: string): Promise<void> {
  memoryMirror.delete(messageId);
  try {
    await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readwrite', (tx) => {
      tx.objectStore(STORE_MESSAGES).delete(messageId);
    });
  } catch (error) {
    warnOnce('[plaintextStore] removePlaintext skipped safely', error);
  }
}

export async function wipePlaintextStore(): Promise<void> {
  memoryMirror.clear();
  try {
    await runTxOn('plaintext-cache', [STORE_MESSAGES, STORE_KEYS], 'readwrite', (tx) => {
      tx.objectStore(STORE_MESSAGES).clear();
      tx.objectStore(STORE_KEYS).clear();
    });
    cachedDeviceKey = null;
    cachedKeyPromise = null;
  } catch (error) {
    warnOnce('[plaintextStore] wipe skipped safely', error);
  }
}
