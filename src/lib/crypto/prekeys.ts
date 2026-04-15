/**
 * Signal-style Prekey System
 * 
 * Each user generates a batch of one-time X25519 key pairs (prekeys).
 * Public halves are uploaded to the server.
 * Private halves are stored locally in IndexedDB.
 * 
 * When Alice wants to message Bob for the first time:
 * 1. Alice consumes one of Bob's prekeys (atomically on server)
 * 2. Alice performs X25519 with Bob's prekey → shared secret
 * 3. Alice derives an AES-256-GCM key via HKDF
 * 4. Message is encrypted — Bob can decrypt using his stored private prekey
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { bufferToBase64, base64ToBuffer } from './utils';
import { KX_KEY_PARAMS, HKDF_HASH, AES_ALGO, AES_KEY_LENGTH, PROTOCOL_VERSION } from './constants';
import { supabase } from '@/integrations/supabase/client';

const PREKEY_DB_NAME = 'forsure-prekeys';
const PREKEY_DB_VERSION = 1;
const PREKEY_STORE = 'private-prekeys';
const PREKEY_BATCH_SIZE = 20;
const PREKEY_REFILL_THRESHOLD = 5;

// ─── IndexedDB for private prekey halves ───

function openPrekeyDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = hardGlobals.idbOpen(PREKEY_DB_NAME, PREKEY_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PREKEY_STORE)) {
        db.createObjectStore(PREKEY_STORE, { keyPath: 'id' });
      }
    };
  });
}

export interface StoredPrivatePrekey {
  id: string; // `${userId}:${prekeyId}`
  prekeyId: number;
  privateKeyJWK: JsonWebKey;
  publicKeyBase64: string;
}

async function savePrivatePrekey(userId: string, prekeyId: number, privateKey: CryptoKey, publicKeyBase64: string): Promise<void> {
  const jwk = await hardCrypto.exportKey('jwk', privateKey);
  const db = await openPrekeyDB();
  const tx = db.transaction(PREKEY_STORE, 'readwrite');
  tx.objectStore(PREKEY_STORE).put({
    id: `${userId}:${prekeyId}`,
    prekeyId,
    privateKeyJWK: jwk,
    publicKeyBase64,
  } as StoredPrivatePrekey);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllStoredPrivatePrekeys(): Promise<StoredPrivatePrekey[]> {
  try {
    const db = await openPrekeyDB();
    const tx = db.transaction(PREKEY_STORE, 'readonly');
    const req = tx.objectStore(PREKEY_STORE).getAll();
    return await new Promise<StoredPrivatePrekey[]>((resolve, reject) => {
      req.onsuccess = () => resolve((req.result || []) as StoredPrivatePrekey[]);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function loadPrivatePrekey(userId: string, prekeyId: number): Promise<CryptoKey | null> {
  try {
    const db = await openPrekeyDB();
    const tx = db.transaction(PREKEY_STORE, 'readonly');
    const req = tx.objectStore(PREKEY_STORE).get(`${userId}:${prekeyId}`);
    const result = await new Promise<StoredPrivatePrekey | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!result) return null;
    return hardCrypto.importKey(
      'jwk', result.privateKeyJWK,
      KX_KEY_PARAMS as any,
      false,
      ['deriveBits'],
    );
  } catch {
    return null;
  }
}

async function getMaxServerPrekeyId(userId: string): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('user_prekeys')
      .select('prekey_id')
      .eq('user_id', userId)
      .order('prekey_id', { ascending: false })
      .limit(1);

    if (error) return 0;
    return data?.[0]?.prekey_id ?? 0;
  } catch {
    return 0;
  }
}

async function getNextPrekeyId(userId: string): Promise<number> {
  try {
    const [allKeys, serverMaxId] = await Promise.all([
      getAllStoredPrivatePrekeys(),
      getMaxServerPrekeyId(userId),
    ]);

    const prefix = `${userId}:`;
    let localMaxId = 0;
    for (const record of allKeys) {
      if (record.id.startsWith(prefix) && record.prekeyId > localMaxId) {
        localMaxId = record.prekeyId;
      }
    }

    return Math.max(localMaxId, serverMaxId) + 1;
  } catch {
    return 1;
  }
}

export async function exportAllPrivatePrekeys(userId: string): Promise<StoredPrivatePrekey[]> {
  const all = await getAllStoredPrivatePrekeys();
  const prefix = `${userId}:`;
  return all.filter((record) => record.id.startsWith(prefix));
}

export async function importAllPrivatePrekeys(records: StoredPrivatePrekey[]): Promise<void> {
  if (!records.length) return;
  const db = await openPrekeyDB();
  const tx = db.transaction(PREKEY_STORE, 'readwrite');
  const store = tx.objectStore(PREKEY_STORE);
  for (const record of records) {
    store.put(record);
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  console.log(`[PREKEY] ${records.length} private prekeys restored`);
}

export async function wipePrivatePrekeys(userId?: string): Promise<void> {
  try {
    const db = await openPrekeyDB();
    const tx = db.transaction(PREKEY_STORE, 'readwrite');
    const store = tx.objectStore(PREKEY_STORE);

    if (!userId) {
      store.clear();
    } else {
      const records = await getAllStoredPrivatePrekeys();
      const prefix = `${userId}:`;
      for (const record of records) {
        if (record.id.startsWith(prefix)) {
          store.delete(record.id);
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[PREKEY] Failed to wipe private prekeys:', e);
  }
}

export async function reconcilePrekeysWithServer(userId: string): Promise<void> {
  try {
    const [localRecords, serverResponse] = await Promise.all([
      exportAllPrivatePrekeys(userId),
      supabase
        .from('user_prekeys')
        .select('prekey_id')
        .eq('user_id', userId)
        .is('consumed_at', null),
    ]);

    const serverRows = serverResponse.data || [];
    const localIds = new Set(localRecords.map((record) => record.prekeyId));
    const missingOnDevice = serverRows
      .map((row) => row.prekey_id)
      .filter((prekeyId) => !localIds.has(prekeyId));

    if (missingOnDevice.length > 0) {
      console.error(`[PREKEY] Local/server mismatch detected — ${missingOnDevice.length} server OPKs missing locally`);

      const { error: deleteError } = await supabase
        .from('user_prekeys')
        .delete()
        .eq('user_id', userId)
        .in('prekey_id', missingOnDevice);

      if (deleteError) {
        console.error('[PREKEY] Failed to invalidate orphaned server OPKs:', deleteError);
      } else {
        console.warn(`[PREKEY] Invalidated orphaned server OPKs: ${missingOnDevice.join(', ')}`);
      }
    }

    const remainingServerCount = Math.max(0, serverRows.length - missingOnDevice.length);
    if (remainingServerCount < PREKEY_REFILL_THRESHOLD || missingOnDevice.length > 0) {
      console.log('[PREKEY] Replenishing OPKs after reconciliation');
      await generateAndUploadPrekeys(userId);
    }
  } catch (e) {
    console.error('[PREKEY] Reconciliation failed:', e);
  }
}

// ─── Public API ───

/**
 * Generate a batch of prekeys and upload public halves to server.
 * Private halves are stored locally in IndexedDB.
 */
export async function generateAndUploadPrekeys(userId: string): Promise<number> {
  const startId = await getNextPrekeyId(userId);
  const prekeys: { user_id: string; prekey_id: number; public_key: string }[] = [];

  for (let i = 0; i < PREKEY_BATCH_SIZE; i++) {
    const prekeyId = startId + i;
    const keyPair = await hardCrypto.generateKey(
      KX_KEY_PARAMS as any, true, ['deriveBits'],
    ) as CryptoKeyPair;

    const publicRaw = await hardCrypto.exportKey('raw', keyPair.publicKey);
    const publicBase64 = bufferToBase64(publicRaw);

    await savePrivatePrekey(userId, prekeyId, keyPair.privateKey, publicBase64);

    prekeys.push({
      user_id: userId,
      prekey_id: prekeyId,
      public_key: publicBase64,
    });
  }

  const { error } = await supabase
    .from('user_prekeys')
    .insert(prekeys);

  if (error) {
    console.error('[PREKEY] Upload failed:', error);
    return 0;
  }

  console.log(`[PREKEY] Generated & uploaded ${PREKEY_BATCH_SIZE} prekeys (${startId}-${startId + PREKEY_BATCH_SIZE - 1})`);
  return PREKEY_BATCH_SIZE;
}

/**
 * Check if the user needs more prekeys and generate them if so.
 * Also self-heals when server still advertises OPKs that no longer exist locally.
 */
export async function refillPrekeysIfNeeded(userId: string): Promise<void> {
  try {
    await reconcilePrekeysWithServer(userId);
  } catch (e) {
    console.error('[PREKEY] Refill check failed:', e);
  }
}

/**
 * Consume a peer's prekey and derive a shared secret for encryption.
 * Returns null if peer has no prekeys available.
 */
export async function consumePeerPrekey(
  myPrivateKey: CryptoKey,
  peerUserId: string,
  conversationId: string,
): Promise<{ sharedSecret: CryptoKey; prekeyId: number } | null> {
  const { data, error } = await supabase
    .rpc('consume_prekey', { p_peer_user_id: peerUserId });

  if (error || !data || data.length === 0) {
    console.warn('[PREKEY] No prekeys available for peer:', peerUserId);
    return null;
  }

  const consumed = data[0];
  const peerPrekeyPublic = await hardCrypto.importKey(
    'raw',
    base64ToBuffer(consumed.public_key),
    KX_KEY_PARAMS as any,
    true,
    [],
  );

  const sharedBits = await hardCrypto.deriveBits(
    { name: 'X25519', public: peerPrekeyPublic } as any,
    myPrivateKey,
    256,
  );

  const encoder = new TextEncoder();
  const saltSource = encoder.encode(`forsure-prekey-salt-v${PROTOCOL_VERSION}-${conversationId}`);
  const salt = new Uint8Array(await hardCrypto.digest('SHA-256', saltSource)) as Uint8Array<ArrayBuffer>;
  const info = encoder.encode(`forsure-prekey-v${PROTOCOL_VERSION}-${conversationId}-${consumed.prekey_id}`);

  const hkdfKey = await hardCrypto.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

  const sharedSecret = await hardCrypto.deriveKey(
    { name: 'HKDF', hash: HKDF_HASH, salt, info },
    hkdfKey,
    { name: AES_ALGO, length: AES_KEY_LENGTH },
    true,
    ['encrypt', 'decrypt'],
  );

  console.log(`[PREKEY] ✅ Derived shared secret from prekey #${consumed.prekey_id}`);
  return { sharedSecret, prekeyId: consumed.prekey_id };
}

/**
 * Derive shared secret from a received prekey ID (receiver side).
 * The receiver looks up their own private prekey and derives the same secret.
 */
export async function deriveFromOwnPrekey(
  userId: string,
  prekeyId: number,
  senderPublicKeyBase64: string,
  conversationId: string,
): Promise<CryptoKey | null> {
  const privateKey = await loadPrivatePrekey(userId, prekeyId);
  if (!privateKey) {
    console.warn(`[PREKEY] Private prekey #${prekeyId} not found locally`);
    return null;
  }

  const senderPublicKey = await hardCrypto.importKey(
    'raw',
    base64ToBuffer(senderPublicKeyBase64),
    KX_KEY_PARAMS as any,
    true,
    [],
  );

  const sharedBits = await hardCrypto.deriveBits(
    { name: 'X25519', public: senderPublicKey } as any,
    privateKey,
    256,
  );

  const encoder = new TextEncoder();
  const saltSource = encoder.encode(`forsure-prekey-salt-v${PROTOCOL_VERSION}-${conversationId}`);
  const salt = new Uint8Array(await hardCrypto.digest('SHA-256', saltSource)) as Uint8Array<ArrayBuffer>;
  const info = encoder.encode(`forsure-prekey-v${PROTOCOL_VERSION}-${conversationId}-${prekeyId}`);

  const hkdfKey = await hardCrypto.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

  return hardCrypto.deriveKey(
    { name: 'HKDF', hash: HKDF_HASH, salt, info },
    hkdfKey,
    { name: AES_ALGO, length: AES_KEY_LENGTH },
    true,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Check how many prekeys a peer has available (for UI display).
 */
export async function getPeerPrekeyCount(peerUserId: string): Promise<number> {
  const { count } = await supabase
    .from('user_prekeys')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', peerUserId)
    .is('consumed_at', null);
  return count ?? 0;
}
