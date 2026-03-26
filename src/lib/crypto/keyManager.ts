/**
 * ForSure Key Manager
 * X25519 key exchange + Ed25519 signing
 * Keys NEVER leave the device unencrypted
 */

import {
  DB_NAME, DB_VERSION, STORE_KEYS, STORE_SESSION, STORE_PREKEYS,
  KX_KEY_PARAMS, SIG_KEY_PARAMS,
} from './constants';
import { exportKeyToJWK, importKeyFromJWK, bufferToBase64, randomBytes } from './utils';

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
      // Wipe old stores on version bump (re-keying)
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
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  const hash = await crypto.subtle.digest('SHA-256', raw);
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
  const [kxPair, sigPair] = await Promise.all([
    crypto.subtle.generateKey(KX_KEY_PARAMS as any, true, ['deriveBits']),
    crypto.subtle.generateKey(SIG_KEY_PARAMS as any, true, ['sign', 'verify']),
  ]);

  const fingerprint = await computeFingerprint((kxPair as CryptoKeyPair).publicKey);

  return {
    publicKey: (kxPair as CryptoKeyPair).publicKey,
    privateKey: (kxPair as CryptoKeyPair).privateKey,
    signingPublicKey: (sigPair as CryptoKeyPair).publicKey,
    signingPrivateKey: (sigPair as CryptoKeyPair).privateKey,
    createdAt: Date.now(),
    fingerprint,
  };
}

/** Save identity keys to IndexedDB */
export async function saveIdentityKeys(userId: string, keys: IdentityKeyPair): Promise<void> {
  const [publicKeyJWK, privateKeyJWK, signingPublicKeyJWK, signingPrivateKeyJWK] = await Promise.all([
    exportKeyToJWK(keys.publicKey),
    exportKeyToJWK(keys.privateKey),
    exportKeyToJWK(keys.signingPublicKey),
    exportKeyToJWK(keys.signingPrivateKey),
  ]);

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

/** Load identity keys from IndexedDB */
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
    crypto.subtle.exportKey('raw', keys.publicKey),
    crypto.subtle.exportKey('raw', keys.signingPublicKey),
  ]);

  return {
    identityKey: bufferToBase64(identityRaw),
    signingKey: bufferToBase64(signingRaw),
    fingerprint: keys.fingerprint,
  };
}

/** Save a session key */
export async function saveSessionKey(session: SessionKey): Promise<void> {
  const keyJWK = await exportKeyToJWK(session.sharedSecret);
  await dbPut<StoredSessionKey>(STORE_SESSION, {
    conversationId: session.conversationId,
    keyJWK,
    messageCount: session.messageCount,
    createdAt: session.createdAt,
    peerFingerprint: session.peerFingerprint,
  });
}

/** Load a session key */
export async function loadSessionKey(conversationId: string): Promise<SessionKey | null> {
  const stored = await dbGet<StoredSessionKey>(STORE_SESSION, conversationId);
  if (!stored) return null;

  const sharedSecret = await crypto.subtle.importKey(
    'jwk', stored.keyJWK,
    { name: 'AES-GCM', length: 256 },
    false,  // Session keys MUST be non-extractable at runtime
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
  const session = await loadSessionKey(conversationId);
  if (!session) return 0;
  session.messageCount += 1;
  await saveSessionKey(session);
  return session.messageCount;
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
