/**
 * Persistent plaintext cache for messages — hardened IndexedDB version.
 *
 * Migrated to dbRegistry + runTxOn for Safari-safe singleton + queue.
 */

import { runTxOn, reqToPromise } from './indexedDbTx';

const STORE_MESSAGES = 'messages';
const STORE_KEYS = 'device-keys';
const DEVICE_KEY_ID = 'plaintext-cache-key-v1';

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

function warnOnce(message: string, error?: unknown) {
  const now = Date.now();
  if (now - lastIndexedDbWarningAt < 5000) return;
  lastIndexedDbWarningAt = now;
  console.warn(message, error);
}

async function getOrCreateDeviceKey(): Promise<CryptoKey> {
  if (cachedDeviceKey) return cachedDeviceKey;
  if (cachedKeyPromise) return cachedKeyPromise;

  cachedKeyPromise = (async () => {
    // Lecture robuste de la clé existante. CRITIQUE : il faut distinguer
    // "la clé n'existe pas" (→ on peut en créer une) de "la lecture a échoué"
    // (→ erreur transitoire : NE PAS régénérer, sinon on écrase la clé et TOUS
    // les plaintexts déjà chiffrés deviennent illisibles → bulles vides à la
    // reconnexion). C'était la cause du bug : un simple .catch(()=>undefined)
    // traitait une erreur de lecture comme une absence de clé.
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
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 120 * (attempt + 1))); // petit backoff
      }
    }

    if (readOk && existing?.key) {
      cachedDeviceKey = existing.key;
      return existing.key;
    }

    // La lecture a échoué 3 fois → on ne sait PAS si la clé existe. Abandonner
    // sans générer de nouvelle clé, pour ne jamais écraser l'accès aux anciens
    // messages. Le cache mémoire prend le relais le temps de la session ; la
    // prochaine tentative (reconnexion suivante) pourra relire la vraie clé.
    if (!readOk) {
      cachedKeyPromise = null;
      throw new Error('[plaintextStore] device key read failed, refusing to regenerate: ' + String(lastErr));
    }

    // Lecture OK et clé réellement absente (premier lancement) → on la crée.
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );

    await runTxOn('plaintext-cache', [STORE_KEYS], 'readwrite', (tx) => {
      tx.objectStore(STORE_KEYS).put({ id: DEVICE_KEY_ID, key });
    }).catch((e) => warnOnce('[plaintextStore] device key persist failed', e));

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
const DEFAULT_BACKUP_EXPORT_CAP = 500;

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
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: entry.iv }, key, entry.ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function exportPlaintextCache(limit = DEFAULT_BACKUP_EXPORT_CAP): Promise<PlaintextCacheExportEntry[]> {
  try {
    const entries = await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readonly', (tx) =>
      reqToPromise(tx.objectStore(STORE_MESSAGES).getAll() as IDBRequest<StoredEntry[]>),
    );

    const exported: PlaintextCacheExportEntry[] = [];
    const recentEntries = entries
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, Math.max(0, limit));

    for (const entry of recentEntries) {
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
  try {
    const map = readSessionMirror();
    if (map[messageId]) {
      delete map[messageId];
      writeSessionMirror(map);
    }

    await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readwrite', (tx) => {
      tx.objectStore(STORE_MESSAGES).delete(messageId);
    });
  } catch (error) {
    warnOnce('[plaintextStore] removePlaintext skipped safely', error);
  }
}

export async function wipePlaintextStore(): Promise<void> {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SESSION_MIRROR_KEY);
  } catch {}

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
