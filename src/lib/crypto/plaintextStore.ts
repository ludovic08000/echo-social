/**
 * Persistent plaintext cache for messages — hardened IndexedDB version.
 *
 * Migrated to dbRegistry + runTxOn for Safari-safe singleton + queue.
 */

import { runTxOn, reqToPromise } from './indexedDbTx';

const STORE_MESSAGES = 'messages';
const STORE_KEYS = 'device-keys';
const DEVICE_KEY_ID = 'plaintext-cache-key-v1';
const DEFAULT_BACKUP_EXPORT_CAP = 500;

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

interface RetentionEntry {
  id: string;
  ephemeral: true;
  expiresAt: number | null;
  aliases: string[];
  pending?: boolean;
}
const retentionKey = (id: string) => `retention:${id}`;

async function readRetention(id: string): Promise<RetentionEntry | undefined> {
  return runTxOn('plaintext-cache', [STORE_MESSAGES], 'readonly', tx =>
    reqToPromise(tx.objectStore(STORE_MESSAGES).get(retentionKey(id)) as IDBRequest<RetentionEntry | undefined>));
}

/** Métadonnées seules : les sauvegardes excluent les messages éphémères,
 * même avant lecture. Une échéance atteinte est un refus durable de restauration. */
export async function registerPlaintextRetention(messageId: string, body: string | null | undefined, expiresAt: number | null, pending = false): Promise<void> {
  const aliases = [...new Set([messageId, `aegis-capsule:${messageId}`,
    ...(body ? [await toCiphertextLookupKey(body)] : [])])];
  await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readwrite', tx => {
    const store = tx.objectStore(STORE_MESSAGES);
    const request = store.get(retentionKey(messageId)) as IDBRequest<RetentionEntry | undefined>;
    request.onsuccess = () => {
    const existing = request.result;
    const combined = [...new Set([...aliases, ...(existing?.aliases ?? [])])];
    // Lecture et écriture dans la même transaction : une réponse tardive ne
    // peut pas prolonger le délai déjà confirmé par un autre appareil.
    const expiry = existing?.expiresAt == null ? expiresAt
      : expiresAt == null ? existing.expiresAt : Math.min(existing.expiresAt, expiresAt);
    for (const alias of combined) {
      store.put({ id: retentionKey(alias), ephemeral: true, expiresAt: expiry, aliases: combined,
        pending: existing ? existing.pending === true && pending : pending } satisfies RetentionEntry);
      if (expiry !== null && expiry <= Date.now()) {
        volatileMirror.delete(alias);
        store.delete(alias);
      }
    }
    };
  });
}

/** Seule une ligne serveur non éphémère peut lever l'exclusion provisoire
 * d'un envoi en attente. Une tombstone ou une politique confirmée est irréversible. */
export async function confirmPlaintextPermanent(messageId: string | string[]): Promise<void> {
  await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readwrite', tx => {
    const store = tx.objectStore(STORE_MESSAGES);
    for (const id of typeof messageId === 'string' ? [messageId] : messageId) {
    const request = store.get(retentionKey(id)) as IDBRequest<RetentionEntry | undefined>;
    request.onsuccess = () => {
      const row = request.result;
      if (row?.pending === true && row.expiresAt === null) {
        for (const alias of row.aliases) store.delete(retentionKey(alias));
      }
    };
    }
  });
}

async function isCacheExpired(id: string): Promise<boolean> {
  const retention = await readRetention(id);
  if (retention?.expiresAt != null && retention.expiresAt <= Date.now()) {
    volatileMirror.delete(id);
    return true;
  }
  return false;
}

export async function isPlaintextExpired(messageId: string): Promise<boolean> {
  return isCacheExpired(messageId);
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

const volatileMirror = new Map<string, string>();

function mirrorSet(id: string, plaintext: string) {
  volatileMirror.set(id, plaintext);
}

function mirrorGet(id: string): string | null {
  return volatileMirror.get(id) ?? null;
}

function entryAAD(id: string): Uint8Array {
  return new TextEncoder().encode(`aegis-plaintext-cache-v1|${id}`);
}

async function saveEntry(id: string, plaintext: string): Promise<void> {
  if (!id || !plaintext) return;
  if (await isCacheExpired(id)) return;
  const key = await getOrCreateDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: entryAAD(id) as BufferSource },
    key,
    new TextEncoder().encode(plaintext),
  );

  await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readwrite', (tx) => {
    const store = tx.objectStore(STORE_MESSAGES);
    const check = store.get(retentionKey(id)) as IDBRequest<RetentionEntry | undefined>;
    check.onsuccess = () => {
      if (check.result?.expiresAt != null && check.result.expiresAt <= Date.now()) {
        volatileMirror.delete(id); store.delete(id); return;
      }
      store.put({ id, iv: iv.buffer, ct, ts: Date.now() } satisfies StoredEntry);
    };
  });
}

async function loadEntry(id: string): Promise<string | null> {
  if (!id) return null;
  if (await isCacheExpired(id)) return null;

  const entry = await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_MESSAGES).get(id) as IDBRequest<StoredEntry | undefined>),
  ).catch(() => undefined);

  if (!entry) return null;

  const key = await getOrCreateDeviceKey();
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: entry.iv, additionalData: entryAAD(id) as BufferSource },
      key,
      entry.ct,
    );
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
      .filter(entry => !entry.id.startsWith('retention:'))
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, Math.max(0, limit));

    for (const entry of recentEntries) {
      if (await readRetention(entry.id)) continue;
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
  try {
    if (await isCacheExpired(messageId)) return null;
    const mirror = mirrorGet(messageId);
    if (mirror !== null) return mirror;
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
    if (await isCacheExpired(id)) return null;
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
    volatileMirror.delete(messageId);

    await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readwrite', (tx) => {
      tx.objectStore(STORE_MESSAGES).delete(messageId);
    });
  } catch (error) {
    warnOnce('[plaintextStore] removePlaintext skipped safely', error);
  }
}

export async function removePlaintextForCiphertext(ciphertextBody: string): Promise<void> {
  if (!ciphertextBody) return;
  try {
    const id = await toCiphertextLookupKey(ciphertextBody);
    volatileMirror.delete(id);
    await runTxOn('plaintext-cache', [STORE_MESSAGES], 'readwrite', (tx) => {
      tx.objectStore(STORE_MESSAGES).delete(id);
    });
  } catch (error) {
    warnOnce('[plaintextStore] remove ciphertext lookup skipped safely', error);
  }
}

export async function wipePlaintextStore(): Promise<void> {
  volatileMirror.clear();

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
