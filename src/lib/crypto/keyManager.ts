/**
 * ForSure Key Manager (v5 — Hardened)
 * X25519 key exchange + Ed25519 signing
 * 
 * SECURITY:
 * - Private keys are stored as JWK in IndexedDB (needed for re-import)
 * - At runtime, private keys are ALWAYS imported as non-extractable
 * - When PIN wrap is active, raw JWKs are deleted from identity-keys store
 * - Session keys imported as non-extractable at runtime
 */

import {
  DB_NAME, DB_VERSION, STORE_KEYS, STORE_SESSION, STORE_PREKEYS,
  KX_KEY_PARAMS, SIG_KEY_PARAMS,
} from './constants';
import { exportKeyToJWK, importKeyFromJWK, bufferToBase64, randomBytes } from './utils';
import { hardCrypto, scrubBuffer } from './cryptoIntegrity';

export interface IdentityKeyPair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  signingPublicKey: CryptoKey;
  signingPrivateKey: CryptoKey;
  createdAt: number;
  fingerprint: string;
}

export interface SessionKey {
  conversationId: string;
  sharedSecret: CryptoKey; // AES-GCM key derived from X25519
  messageCount: number;
  createdAt: number;
  peerFingerprint: string;
}

interface StoredKeyPair {
  publicKeyJWK: JsonWebKey;
  privateKeyJWK: JsonWebKey;
  signingPublicKeyJWK: JsonWebKey;
  signingPrivateKeyJWK: JsonWebKey;
  createdAt: number;
  fingerprint: string;
}

interface StoredSessionKey {
  conversationId: string;
  keyJWK: JsonWebKey;
  messageCount: number;
  createdAt: number;
  peerFingerprint: string;
}

// ─── IndexedDB helpers ───

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [STORE_KEYS, STORE_SESSION, STORE_PREKEYS]) {
        if (db.objectStoreNames.contains(name)) {
          db.deleteObjectStore(name);
        }
      }
      db.createObjectStore(STORE_KEYS, { keyPath: 'id' });
      db.createObjectStore(STORE_SESSION, { keyPath: 'conversationId' });
      db.createObjectStore(STORE_PREKEYS, { keyPath: 'id' });
    };
  });
}

function dbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  }));
}

function dbPut<T>(storeName: string, value: T): Promise<void> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}

function dbDelete(storeName: string, key: string): Promise<void> {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}

// ─── Fingerprint (safety numbers) ───

async function computeFingerprint(publicKey: CryptoKey): Promise<string> {
  const raw = await hardCrypto.exportKey('raw', publicKey);
  const hash = await hardCrypto.digest('SHA-256', raw);
  const bytes = new Uint8Array(hash);
  let fp = '';
  for (let i = 0; i < 20; i++) {
    if (i > 0 && i % 4 === 0) fp += ' ';
    fp += bytes[i].toString(16).padStart(2, '0');
  }
  return fp.toUpperCase();
}

// ─── Public API ───

/** Generate identity keys: X25519 (exchange) + Ed25519 (signing) */
export async function generateIdentityKeys(): Promise<IdentityKeyPair> {
  // Generate with extractable=true (needed for initial JWK export to persist)
  const [kxPair, sigPair] = await Promise.all([
    hardCrypto.generateKey(KX_KEY_PARAMS as any, true, ['deriveBits']),
    hardCrypto.generateKey(SIG_KEY_PARAMS as any, true, ['sign', 'verify']),
  ]);

  const fingerprint = await computeFingerprint((kxPair as CryptoKeyPair).publicKey);

  // Export JWKs for storage, then re-import private keys as NON-EXTRACTABLE
  const [privJWK, sigPrivJWK] = await Promise.all([
    exportKeyToJWK((kxPair as CryptoKeyPair).privateKey),
    exportKeyToJWK((sigPair as CryptoKeyPair).privateKey),
  ]);

  const [privateKeyNonExtractable, sigPrivNonExtractable] = await Promise.all([
    importKeyFromJWK(privJWK, KX_KEY_PARAMS as any, ['deriveBits'], false),
    importKeyFromJWK(sigPrivJWK, SIG_KEY_PARAMS as any, ['sign'], false),
  ]);

  return {
    publicKey: (kxPair as CryptoKeyPair).publicKey,
    privateKey: privateKeyNonExtractable,
    signingPublicKey: (sigPair as CryptoKeyPair).publicKey,
    signingPrivateKey: sigPrivNonExtractable,
    createdAt: Date.now(),
    fingerprint,
    // Attach JWKs for one-time storage (NOT on the interface, stored separately)
    ...(({ _privJWK: privJWK, _sigPrivJWK: sigPrivJWK }) as any),
  };
}

/** Save identity keys to IndexedDB */
export async function saveIdentityKeys(userId: string, keys: IdentityKeyPair): Promise<void> {
  // Public keys: always exportable (needed for server publication)
  const [publicKeyJWK, signingPublicKeyJWK] = await Promise.all([
    exportKeyToJWK(keys.publicKey),
    exportKeyToJWK(keys.signingPublicKey),
  ]);

  // Private key JWKs: use attached JWKs from generation, or re-export if extractable
  let privateKeyJWK: JsonWebKey;
  let signingPrivateKeyJWK: JsonWebKey;

  const attached = keys as any;
  if (attached._privJWK && attached._sigPrivJWK) {
    // Fresh from generateIdentityKeys — JWKs are attached
    privateKeyJWK = attached._privJWK;
    signingPrivateKeyJWK = attached._sigPrivJWK;
  } else {
    // Fallback: try export (will fail if non-extractable, which is correct after PIN wrap)
    try {
      privateKeyJWK = await exportKeyToJWK(keys.privateKey);
      signingPrivateKeyJWK = await exportKeyToJWK(keys.signingPrivateKey);
    } catch {
      console.warn('[KEY_MGR] Cannot export private keys (already non-extractable). Skipping save.');
      return;
    }
  }

  await dbPut<StoredKeyPair & { id: string }>(STORE_KEYS, {
    id: userId,
    publicKeyJWK,
    privateKeyJWK,
    signingPublicKeyJWK,
    signingPrivateKeyJWK,
    createdAt: keys.createdAt,
    fingerprint: keys.fingerprint,
  });
}

/** Load identity keys from IndexedDB — private keys are ALWAYS non-extractable */
export async function loadIdentityKeys(userId: string): Promise<IdentityKeyPair | null> {
  const stored = await dbGet<StoredKeyPair & { id: string }>(STORE_KEYS, userId);
  if (!stored) return null;

  const [publicKey, privateKey, signingPublicKey, signingPrivateKey] = await Promise.all([
    importKeyFromJWK(stored.publicKeyJWK, KX_KEY_PARAMS as any, [], true),     // public: exportable for server
    importKeyFromJWK(stored.privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], false), // PRIVATE: non-extractable
    importKeyFromJWK(stored.signingPublicKeyJWK, SIG_KEY_PARAMS as any, ['verify'], true),
    importKeyFromJWK(stored.signingPrivateKeyJWK, SIG_KEY_PARAMS as any, ['sign'], false), // PRIVATE: non-extractable
  ]);

  return {
    publicKey,
    privateKey,
    signingPublicKey,
    signingPrivateKey,
    createdAt: stored.createdAt,
    fingerprint: stored.fingerprint,
  };
}

/** Get or create identity keys */
export async function getOrCreateIdentityKeys(userId: string): Promise<IdentityKeyPair> {
  const existing = await loadIdentityKeys(userId);
  if (existing) return existing;

  const newKeys = await generateIdentityKeys();
  await saveIdentityKeys(userId, newKeys);
  return newKeys;
}

/** Export public key bundle for server publication */
export async function exportPublicKeyBundle(keys: IdentityKeyPair): Promise<{
  identityKey: string;
  signingKey: string;
  fingerprint: string;
}> {
  const [identityRaw, signingRaw] = await Promise.all([
    hardCrypto.exportKey('raw', keys.publicKey),
    hardCrypto.exportKey('raw', keys.signingPublicKey),
  ]);

  return {
    identityKey: bufferToBase64(identityRaw),
    signingKey: bufferToBase64(signingRaw),
    fingerprint: keys.fingerprint,
  };
}

/** Save a session key (JWK stored for persistence, re-imported as non-extractable) */
export async function saveSessionKey(session: SessionKey): Promise<void> {
  // Session secret must be extractable for storage — we re-import from JWK at load time as non-extractable
  let keyJWK: JsonWebKey;
  try {
    keyJWK = await exportKeyToJWK(session.sharedSecret);
  } catch {
    // Key is non-extractable (already loaded from DB) — reload JWK from stored version
    const existing = await dbGet<StoredSessionKey>(STORE_SESSION, session.conversationId);
    if (!existing) {
      console.warn('[KEY_MGR] Cannot save session key: non-extractable and no stored JWK');
      return;
    }
    keyJWK = existing.keyJWK;
  }

  await dbPut<StoredSessionKey>(STORE_SESSION, {
    conversationId: session.conversationId,
    keyJWK,
    messageCount: session.messageCount,
    createdAt: session.createdAt,
    peerFingerprint: session.peerFingerprint,
  });
}

/** Load a session key — ALWAYS non-extractable at runtime */
export async function loadSessionKey(conversationId: string): Promise<SessionKey | null> {
  const stored = await dbGet<StoredSessionKey>(STORE_SESSION, conversationId);
  if (!stored) return null;

  const sharedSecret = await crypto.subtle.importKey(
    'jwk', stored.keyJWK,
    { name: 'AES-GCM', length: 256 },
    false,  // NON-EXTRACTABLE at runtime
    ['encrypt', 'decrypt']
  );

  return {
    conversationId: stored.conversationId,
    sharedSecret,
    messageCount: stored.messageCount,
    createdAt: stored.createdAt,
    peerFingerprint: stored.peerFingerprint,
  };
}

/** Delete a session key */
export async function deleteSessionKey(conversationId: string): Promise<void> {
  await dbDelete(STORE_SESSION, conversationId);
}

/** Increment message count for key rotation tracking */
export async function incrementSessionMessageCount(conversationId: string): Promise<number> {
  const stored = await dbGet<StoredSessionKey>(STORE_SESSION, conversationId);
  if (!stored) return 0;
  stored.messageCount += 1;
  await dbPut<StoredSessionKey>(STORE_SESSION, stored);
  return stored.messageCount;
}

/** Delete raw identity keys from IndexedDB (after PIN wrap) */
export async function deleteRawIdentityKeys(userId: string): Promise<void> {
  await dbDelete(STORE_KEYS, userId);
  console.log('[KEY_MGR] Raw identity keys deleted from IndexedDB (PIN-wrapped)');
}

/** Check if raw identity keys exist in IndexedDB */
export async function hasRawIdentityKeys(userId: string): Promise<boolean> {
  const stored = await dbGet<StoredKeyPair & { id: string }>(STORE_KEYS, userId);
  return !!stored;
}

/** Wipe all keys (logout / account deletion) */
export async function wipeAllKeys(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction([STORE_KEYS, STORE_SESSION, STORE_PREKEYS], 'readwrite');
  tx.objectStore(STORE_KEYS).clear();
  tx.objectStore(STORE_SESSION).clear();
  tx.objectStore(STORE_PREKEYS).clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
