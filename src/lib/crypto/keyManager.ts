/**
 * ForSure Key Manager (v5 — Hardened)
 * X25519 key exchange + Ed25519 signing
 */

import {
  STORE_KEYS, STORE_SESSION, STORE_PREKEYS,
  KX_KEY_PARAMS, SIG_KEY_PARAMS,
} from './constants';
import { isIndexedDBClosingError, openE2EEDB, reopenE2EEDB } from './indexedDb';
import { exportKeyToJWK, importKeyFromJWK, bufferToBase64, base64ToBuffer } from './utils';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import * as memCache from './memoryIdentityCache';
import { runTxOn, reqToPromise } from './indexedDbTx';

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
  sharedSecret: CryptoKey;
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

function openDB(forceFresh = false): Promise<IDBDatabase> {
  return forceFresh ? reopenE2EEDB() : openE2EEDB();
}

async function dbGet<T>(storeName: string, key: string, forceFresh = false): Promise<T | undefined> {
  try {
    return await openDB(forceFresh).then(db => new Promise<T | undefined>((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result as T | undefined);
        req.onerror = () => reject(req.error);
      } catch (error) {
        reject(error);
      }
    }));
  } catch (error) {
    if (!forceFresh && isIndexedDBClosingError(error)) {
      console.warn('[KEY_MGR] IndexedDB connection was closing on read; retrying with a fresh connection.');
      return dbGet(storeName, key, true);
    }
    return undefined;
  }
}

async function dbPut<T>(storeName: string, value: T, forceFresh = false): Promise<void> {
  try {
    return await openDB(forceFresh).then(db => new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.put(value);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    } catch (error) {
      reject(error);
    }
    }));
  } catch (error) {
    if (!forceFresh && isIndexedDBClosingError(error)) {
      console.warn('[KEY_MGR] IndexedDB connection was closing; retrying with a fresh connection.');
      return dbPut(storeName, value, true);
    }
    throw error;
  }
}

async function dbDelete(storeName: string, key: string, forceFresh = false): Promise<void> {
  try {
    return await openDB(forceFresh).then(db => new Promise<void>((resolve, reject) => {
      try {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      } catch (error) {
        reject(error);
      }
    }));
  } catch (error) {
    if (!forceFresh && isIndexedDBClosingError(error)) {
      console.warn('[KEY_MGR] IndexedDB connection was closing on delete; retrying with a fresh connection.');
      return dbDelete(storeName, key, true);
    }
    // Best-effort delete: never propagate
  }
}

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

export async function generateIdentityKeys(): Promise<IdentityKeyPair> {
  const [kxPair, sigPair] = await Promise.all([
    hardCrypto.generateKey(KX_KEY_PARAMS as any, true, ['deriveBits']),
    hardCrypto.generateKey(SIG_KEY_PARAMS as any, true, ['sign', 'verify']),
  ]);

  const fingerprint = await computeFingerprint((kxPair as CryptoKeyPair).publicKey);

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
    ...(({ _privJWK: privJWK, _sigPrivJWK: sigPrivJWK }) as any),
  };
}

export async function saveIdentityKeys(userId: string, keys: IdentityKeyPair): Promise<void> {
  const [publicKeyJWK, signingPublicKeyJWK] = await Promise.all([
    exportKeyToJWK(keys.publicKey),
    exportKeyToJWK(keys.signingPublicKey),
  ]);

  let privateKeyJWK: JsonWebKey;
  let signingPrivateKeyJWK: JsonWebKey;

  const attached = keys as any;
  if (attached._privJWK && attached._sigPrivJWK) {
    privateKeyJWK = attached._privJWK;
    signingPrivateKeyJWK = attached._sigPrivJWK;
  } else {
    try {
      privateKeyJWK = await exportKeyToJWK(keys.privateKey);
      signingPrivateKeyJWK = await exportKeyToJWK(keys.signingPrivateKey);
    } catch {
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

  // Hot RAM cache — survives brief IndexedDB outages on Safari/iOS.
  try {
    memCache.set(userId, {
      identityPrivate: keys.privateKey,
      identityPublic: keys.publicKey,
    });
  } catch {}
}

export async function loadIdentityKeys(userId: string): Promise<IdentityKeyPair | null> {
  const stored = await dbGet<StoredKeyPair & { id: string }>(STORE_KEYS, userId);
  if (!stored) return null;

  const [publicKey, privateKey, signingPublicKey, signingPrivateKey] = await Promise.all([
    importKeyFromJWK(stored.publicKeyJWK, KX_KEY_PARAMS as any, [], true),
    importKeyFromJWK(stored.privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], false),
    importKeyFromJWK(stored.signingPublicKeyJWK, SIG_KEY_PARAMS as any, ['verify'], true),
    importKeyFromJWK(stored.signingPrivateKeyJWK, SIG_KEY_PARAMS as any, ['sign'], false),
  ]);

  const result: IdentityKeyPair = {
    publicKey,
    privateKey,
    signingPublicKey,
    signingPrivateKey,
    createdAt: stored.createdAt,
    fingerprint: stored.fingerprint,
    ...(({ _privJWK: stored.privateKeyJWK, _sigPrivJWK: stored.signingPrivateKeyJWK }) as any),
  };

  try {
    memCache.set(userId, {
      identityPrivate: result.privateKey,
      identityPublic: result.publicKey,
    });
  } catch {}

  return result;
}

async function createFreshIdentity(userId: string, reason: string): Promise<IdentityKeyPair & { isNewIdentity?: boolean; recoveredAfterLoss?: boolean }> {
  console.warn('[KEY_MGR] Local identity unavailable — creating fresh persistent identity so user can continue.', { reason });
  const newKeys = await generateIdentityKeys();
  await saveIdentityKeys(userId, newKeys);
  return { ...newKeys, isNewIdentity: false, recoveredAfterLoss: true };
}

export async function getOrCreateIdentityKeys(userId: string): Promise<IdentityKeyPair & { isNewIdentity?: boolean; recoveredAfterLoss?: boolean }> {
  const existing = await loadIdentityKeys(userId);
  if (existing) return existing;

  try {
    const { hasWrappedKeys } = await import('./pinWrap');
    const hasWrap = await hasWrappedKeys(userId);
    if (hasWrap) {
      return await createFreshIdentity(userId, 'pin_wrapped_keys_present_but_not_unlocked');
    }
  } catch {}

  try {
    const { supabase } = await import('@/integrations/supabase/client');
    const [{ data: activeKey }, { data: backup }] = await Promise.all([
      supabase.from('user_public_keys').select('fingerprint').eq('user_id', userId).eq('is_active', true).maybeSingle(),
      supabase.from('user_backups' as any).select('id').eq('user_id', userId).limit(1).maybeSingle(),
    ]);

    if (activeKey || backup) {
      return await createFreshIdentity(userId, 'server_continuity_exists_local_keys_missing');
    }
  } catch {
    return await createFreshIdentity(userId, 'continuity_check_unavailable');
  }

  const newKeys = await generateIdentityKeys();
  await saveIdentityKeys(userId, newKeys);
  return { ...newKeys, isNewIdentity: true };
}

export class PinUnlockRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinUnlockRequiredError';
  }
}

export async function exportPublicKeyBundle(keys: IdentityKeyPair): Promise<{
  identityKey: string;
  signingKey: string;
  fingerprint: string;
}> {
  const exportPublic = async (key: CryptoKey): Promise<string> => {
    try {
      const raw = await hardCrypto.exportKey('raw', key);
      return bufferToBase64(raw as ArrayBuffer);
    } catch (rawErr) {
      try {
        const jwk = (await hardCrypto.exportKey('jwk', key)) as JsonWebKey;
        const xB64Url = jwk?.x;
        if (typeof xB64Url !== 'string' || xB64Url.length === 0) {
          throw new Error(`jwk export produced no x component: ${JSON.stringify({ kty: jwk?.kty, crv: jwk?.crv })}`);
        }
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

export async function saveSessionKey(session: SessionKey): Promise<void> {
  let keyJWK: JsonWebKey;
  try {
    keyJWK = await exportKeyToJWK(session.sharedSecret);
  } catch {
    const existing = await dbGet<StoredSessionKey>(STORE_SESSION, session.conversationId);
    if (!existing) return;
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

export async function loadSessionKey(conversationId: string): Promise<SessionKey | null> {
  const stored = await dbGet<StoredSessionKey>(STORE_SESSION, conversationId);
  if (!stored) return null;

  const sharedSecret = await importKeyFromJWK(
    stored.keyJWK,
    { name: 'AES-GCM', length: 256 } as AesKeyAlgorithm,
    ['encrypt', 'decrypt'],
    false,
  );

  return {
    conversationId: stored.conversationId,
    sharedSecret,
    messageCount: stored.messageCount,
    createdAt: stored.createdAt,
    peerFingerprint: stored.peerFingerprint,
  };
}

export async function deleteSessionKey(conversationId: string): Promise<void> {
  await dbDelete(STORE_SESSION, conversationId);
}

export async function incrementSessionMessageCount(conversationId: string): Promise<number> {
  const stored = await dbGet<StoredSessionKey>(STORE_SESSION, conversationId);
  if (!stored) return 0;
  stored.messageCount += 1;
  await dbPut<StoredSessionKey>(STORE_SESSION, stored);
  return stored.messageCount;
}

export async function deleteRawIdentityKeys(userId: string): Promise<void> {
  try { memCache.clear(userId, 'delete_raw'); } catch {}
  await dbDelete(STORE_KEYS, userId);
}

export async function hasRawIdentityKeys(userId: string): Promise<boolean> {
  if (memCache.has(userId)) return true;
  const stored = await dbGet<StoredKeyPair & { id: string }>(STORE_KEYS, userId);
  return !!stored;
}

export async function wipeAllKeys(): Promise<void> {
  try { memCache.clearAll('wipe_all'); } catch {}
  try {
    const db = await openDB();
    const tx = db.transaction([STORE_KEYS, STORE_SESSION, STORE_PREKEYS], 'readwrite');
    tx.objectStore(STORE_KEYS).clear();
    tx.objectStore(STORE_SESSION).clear();
    tx.objectStore(STORE_PREKEYS).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

export async function wipeSessionKeys(userId?: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE_SESSION], 'readwrite');
    tx.objectStore(STORE_SESSION).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}

  try {
    await runTxOn('ratchet', ['ratchet-states'], 'readwrite', (tx) => {
      tx.objectStore('ratchet-states').clear();
    });
  } catch {}
}

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
}

export async function exportAllRatchetStates(): Promise<any[]> {
  try {
    return await runTxOn('ratchet', ['ratchet-states'], 'readonly', (tx) =>
      reqToPromise(tx.objectStore('ratchet-states').getAll() as IDBRequest<any[]>),
    ) ?? [];
  } catch {
    return [];
  }
}

export async function importAllRatchetStates(records: any[]): Promise<void> {
  if (!records.length) return;
  try {
    await runTxOn('ratchet', ['ratchet-states'], 'readwrite', (tx) => {
      const store = tx.objectStore('ratchet-states');
      for (const r of records) store.put(r);
    });
  } catch {}
}
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}
