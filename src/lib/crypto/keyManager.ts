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
  STORE_KEYS, STORE_SESSION, STORE_PREKEYS,
  KX_KEY_PARAMS, SIG_KEY_PARAMS,
} from './constants';
import { openE2EEDB } from './indexedDb';
import { exportKeyToJWK, importKeyFromJWK, bufferToBase64, base64ToBuffer, randomBytes } from './utils';
import { hardCrypto, hardGlobals, scrubBuffer } from './cryptoIntegrity';

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
  return openE2EEDB();
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

/**
 * Export a public key's raw 32-byte point.
 * iOS Safari fallback: WebKit rejects `exportKey('raw', ...)` for X25519 /
 * Ed25519 public keys with DataError. JWK export ALWAYS works for public
 * keys; `x` is the base64url-encoded raw point.
 */
export async function exportPublicKeyRaw(publicKey: CryptoKey): Promise<ArrayBuffer> {
  try {
    return await hardCrypto.exportKey('raw', publicKey) as ArrayBuffer;
  } catch {
    const jwk = (await hardCrypto.exportKey('jwk', publicKey)) as JsonWebKey;
    const xB64Url = jwk?.x;
    if (typeof xB64Url !== 'string' || xB64Url.length === 0) {
      throw new Error('exportPublicKeyRaw: jwk export missing x component');
    }
    const b64 = xB64Url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
}

async function computeFingerprintFromRaw(raw: ArrayBuffer): Promise<string> {
  const hash = await hardCrypto.digest('SHA-256', raw);
  const bytes = new Uint8Array(hash);
  let fp = '';
  for (let i = 0; i < 20; i++) {
    if (i > 0 && i % 4 === 0) fp += ' ';
    fp += bytes[i].toString(16).padStart(2, '0');
  }
  return fp.toUpperCase();
}

async function computeFingerprint(publicKey: CryptoKey): Promise<string> {
  const raw = await exportPublicKeyRaw(publicKey);
  return computeFingerprintFromRaw(raw);
}

function jwkXToBase64(jwk: JsonWebKey, label: string): string {
  const x = jwk?.x;
  if (typeof x !== 'string' || x.length === 0) {
    throw new Error(`${label} JWK missing x component`);
  }
  const b64 = x.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return b64 + pad;
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

/**
 * Get or create identity keys.
 * 
 * Signal model — recovery order:
 * 1. Try IndexedDB raw keys
 * 2. Try PIN-wrapped keys (forsure-pin-wrap DB)
 * 3. Generate NEW keys (true new identity)
 * 
 * NEVER silently regenerate — if keys existed before, the caller
 * must handle the identity change explicitly.
 */
export async function getOrCreateIdentityKeys(userId: string): Promise<IdentityKeyPair & { isNewIdentity?: boolean }> {
  // 1. Try raw keys from IndexedDB
  const existing = await loadIdentityKeys(userId);
  if (existing) return existing;

  // 2. Try PIN-wrapped keys
  try {
    const { hasWrappedKeys, unwrapKeysWithPin } = await import('./pinWrap');
    const hasWrap = await hasWrappedKeys(userId);
    if (hasWrap) {
      console.log('[KEY_MGR] Raw keys missing but PIN-wrapped keys exist — awaiting PIN unlock');
      // Signal to caller that PIN unlock is needed — don't generate new keys
      throw new PinUnlockRequiredError('PIN unlock required to recover identity keys');
    }
  } catch (e) {
    if (e instanceof PinUnlockRequiredError) throw e;
    // PIN wrap module error — continue to generation
  }

  // 3. Server continuity guard: never create a fresh account identity when
  // the backend already knows this user. iOS can wipe IndexedDB at any time;
  // blindly regenerating here would rotate the fingerprint, make old messages
  // unreadable, and trigger false "key changed" warnings. Let the silent
  // recovery pipeline (Keychain → PIN/account backup) restore the real keys.
  try {
    const { supabase } = await import('@/integrations/supabase/client');
    const [{ data: activeKey }, { data: backup }] = await Promise.all([
      supabase
        .from('user_public_keys')
        .select('fingerprint')
        .eq('user_id', userId)
        .eq('is_active', true)
        .maybeSingle(),
      supabase
        .from('user_backups' as any)
        .select('id')
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle(),
    ]);
    if (activeKey || backup) {
      console.warn('[KEY_MGR] Local identity missing but server continuity exists — blocking regeneration until restore');
      throw new PinUnlockRequiredError('Existing E2EE identity must be restored before use');
    }
  } catch (e) {
    if (e instanceof PinUnlockRequiredError) throw e;
    // Network/RLS failure must not create a replacement identity for an
    // established account. Fail closed; callers will retry/restore silently.
    console.warn('[KEY_MGR] Continuity guard unavailable — refusing unsafe identity regeneration:', e);
    throw new PinUnlockRequiredError('E2EE identity continuity check unavailable');
  }

  // 4. No local keys and no server continuity — true first-time identity.
  console.log('[KEY_MGR] No local keys found — generating new identity');
  const newKeys = await generateIdentityKeys();
  await saveIdentityKeys(userId, newKeys);
  return { ...newKeys, isNewIdentity: true };
}

/** Error thrown when PIN unlock is needed to recover keys */
export class PinUnlockRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinUnlockRequiredError';
  }
}

/** Export public key bundle for server publication */
export async function exportPublicKeyBundle(keys: IdentityKeyPair): Promise<{
  identityKey: string;
  signingKey: string;
  fingerprint: string;
}> {
  const exportPublic = async (key: CryptoKey): Promise<string> => {
    // Primary path: raw export (32 bytes for Ed25519/X25519).
    try {
      const raw = await hardCrypto.exportKey('raw', key);
      return bufferToBase64(raw as ArrayBuffer);
    } catch (rawErr) {
      // iOS Safari fallback: some WebKit builds reject `raw` export of
      // Ed25519/X25519 public keys with DataError ("Data provided to an
      // operation does not meet requirements"). The JWK form ALWAYS works
      // for public keys, and `x` is the base64url-encoded raw point.
      try {
        const jwk = (await hardCrypto.exportKey('jwk', key)) as JsonWebKey;
        const xB64Url = jwk?.x;
        if (typeof xB64Url !== 'string' || xB64Url.length === 0) {
          throw new Error(`jwk export produced no x component: ${JSON.stringify({ kty: jwk?.kty, crv: jwk?.crv })}`);
        }
        // base64url → base64
        const b64 = xB64Url.replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
        return b64 + pad;
      } catch (jwkErr) {
        const rawMsg = rawErr instanceof Error ? rawErr.message : String(rawErr);
        const jwkMsg = jwkErr instanceof Error ? jwkErr.message : String(jwkErr);
        throw new Error(`exportPublicKey failed (raw: ${rawMsg}; jwk: ${jwkMsg})`);
      }
    }
  };

  const [identityKey, signingKey] = await Promise.all([
    exportPublic(keys.publicKey),
    exportPublic(keys.signingPublicKey),
  ]);

  return { identityKey, signingKey, fingerprint: keys.fingerprint };
}

/**
 * Export the public identity bundle directly from the persisted public JWKs.
 *
 * Safari/iOS can refuse `exportKey()` on a restored CryptoKey even when the
 * public JWK is valid. Public JWK `x` is the same 32-byte raw point we publish
 * to the server, so this fallback avoids rebuilding the CryptoKey.
 */
export async function exportPublicKeyBundleFromStoredKeys(userId: string): Promise<{
  identityKey: string;
  signingKey: string;
  fingerprint: string;
} | null> {
  const stored = await dbGet<StoredKeyPair & { id: string }>(STORE_KEYS, userId);
  if (!stored) return null;

  const identityKey = jwkXToBase64(stored.publicKeyJWK, 'identity public key');
  const signingKey = jwkXToBase64(stored.signingPublicKeyJWK, 'signing public key');
  const fingerprint = stored.fingerprint || await computeFingerprintFromRaw(base64ToBuffer(identityKey));

  return { identityKey, signingKey, fingerprint };
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

  const sharedSecret = await importKeyFromJWK(
    stored.keyJWK,
    { name: 'AES-GCM', length: 256 } as AesKeyAlgorithm,
    ['encrypt', 'decrypt'],
    false, // NON-EXTRACTABLE at runtime
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

/**
 * Wipe session keys, ratchet states and private prekeys from IndexedDB.
 * Called on PIN lock AFTER successful wrapping.
 */
export async function wipeSessionKeys(userId?: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE_SESSION], 'readwrite');
    tx.objectStore(STORE_SESSION).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.warn('[KEY_MGR] Failed to clear session keys:', e);
  }

  try {
    const ratchetReq = hardGlobals.idbOpen('forsure-ratchet', 1);
    const ratchetDB = await new Promise<IDBDatabase>((resolve, reject) => {
      ratchetReq.onerror = () => reject(ratchetReq.error);
      ratchetReq.onsuccess = () => resolve(ratchetReq.result);
      ratchetReq.onupgradeneeded = () => {
        const db = ratchetReq.result;
        if (!db.objectStoreNames.contains('ratchet-states')) {
          db.createObjectStore('ratchet-states', { keyPath: 'convId' });
        }
      };
    });
    if (ratchetDB.objectStoreNames.contains('ratchet-states')) {
      const tx = ratchetDB.transaction('ratchet-states', 'readwrite');
      tx.objectStore('ratchet-states').clear();
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  } catch (e) {
    console.warn('[KEY_MGR] Failed to clear ratchet states:', e);
  }

  console.log('[KEY_MGR] Session keys and ratchet states wiped');
}

/** Export all raw session key records from IndexedDB (for PIN wrapping) */
export async function exportAllSessionKeys(): Promise<StoredSessionKey[]> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_SESSION, 'readonly');
    const req = tx.objectStore(STORE_SESSION).getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

/** Import raw session key records into IndexedDB (from PIN unwrap) */
export async function importAllSessionKeys(records: StoredSessionKey[]): Promise<void> {
  if (!records.length) return;
  const db = await openDB();
  const tx = db.transaction(STORE_SESSION, 'readwrite');
  const store = tx.objectStore(STORE_SESSION);
  for (const r of records) store.put(r);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  console.log(`[KEY_MGR] ${records.length} session keys restored`);
}

/** Export all ratchet state records from IndexedDB (for PIN wrapping) */
export async function exportAllRatchetStates(): Promise<any[]> {
  try {
    const ratchetReq = hardGlobals.idbOpen('forsure-ratchet', 1);
    const ratchetDB = await new Promise<IDBDatabase>((resolve, reject) => {
      ratchetReq.onerror = () => reject(ratchetReq.error);
      ratchetReq.onsuccess = () => resolve(ratchetReq.result);
      ratchetReq.onupgradeneeded = () => {
        const db = ratchetReq.result;
        if (!db.objectStoreNames.contains('ratchet-states')) {
          db.createObjectStore('ratchet-states', { keyPath: 'convId' });
        }
      };
    });
    if (!ratchetDB.objectStoreNames.contains('ratchet-states')) return [];
    const tx = ratchetDB.transaction('ratchet-states', 'readonly');
    const req = tx.objectStore('ratchet-states').getAll();
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

/** Import ratchet state records into IndexedDB (from PIN unwrap) */
export async function importAllRatchetStates(records: any[]): Promise<void> {
  if (!records.length) return;
  try {
    const ratchetReq = hardGlobals.idbOpen('forsure-ratchet', 1);
    const ratchetDB = await new Promise<IDBDatabase>((resolve, reject) => {
      ratchetReq.onerror = () => reject(ratchetReq.error);
      ratchetReq.onsuccess = () => resolve(ratchetReq.result);
      ratchetReq.onupgradeneeded = () => {
        const db = ratchetReq.result;
        if (!db.objectStoreNames.contains('ratchet-states')) {
          db.createObjectStore('ratchet-states', { keyPath: 'convId' });
        }
      };
    });
    const tx = ratchetDB.transaction('ratchet-states', 'readwrite');
    const store = tx.objectStore('ratchet-states');
    for (const r of records) store.put(r);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    console.log(`[KEY_MGR] ${records.length} ratchet states restored`);
  } catch (e) {
    console.warn('[KEY_MGR] Failed to restore ratchet states:', e);
  }
}
