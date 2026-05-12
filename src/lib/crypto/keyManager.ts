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
import { reqToPromise, runTxOn } from './indexedDbTx';
import { exportKeyToJWK, importKeyFromJWK, bufferToBase64, base64ToBuffer, constantTimeEqual } from './utils';
import { hardCrypto } from './cryptoIntegrity';
import { supabase } from '@/integrations/supabase/client';

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

export interface ServerIdentityState {
  identityKey: string;
  signingKey: string;
  fingerprint: string;
}

export interface ServerContinuityState {
  identity: ServerIdentityState | null;
  hasAnyPublicKey: boolean;
  hasBackup: boolean;
  backupTypes: string[];
}

export interface IdentityKeyLoadOptions {
  allowCreate?: boolean;
}

const memCache = new Map<string, IdentityKeyPair>();

function isCompleteIdentityKeys(keys: IdentityKeyPair | undefined): keys is IdentityKeyPair {
  return !!(
    keys?.publicKey &&
    keys.privateKey &&
    keys.signingPublicKey &&
    keys.signingPrivateKey &&
    typeof keys.fingerprint === 'string' &&
    typeof keys.createdAt === 'number'
  );
}

function cacheIdentity(userId: string, keys: IdentityKeyPair): void {
  const {
    publicKey,
    privateKey,
    signingPublicKey: signingPublic,
    signingPrivateKey: signingPrivate,
    fingerprint,
    createdAt,
  } = keys;

  memCache.set(userId, {
    publicKey,
    privateKey,
    signingPublicKey: signingPublic,
    signingPrivateKey: signingPrivate,
    fingerprint,
    createdAt,
  });
}

export function clearIdentityMemoryCache(userId?: string): void {
  if (userId) memCache.delete(userId);
  else memCache.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('forsure-keys-locked', () => clearIdentityMemoryCache());
}

// ─── IndexedDB helpers ───

function dbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  return runTxOn('e2ee', storeName, 'readonly', (store) =>
    reqToPromise<T | undefined>(store.get(key)),
  );
}

function dbPut<T>(storeName: string, value: T): Promise<void> {
  return runTxOn('e2ee', storeName, 'readwrite', (store) => {
    store.put(value);
  });
}

function dbDelete(storeName: string, key: string): Promise<void> {
  return runTxOn('e2ee', storeName, 'readwrite', (store) => {
    store.delete(key);
  });
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

function normalizeFingerprint(fp: string | null | undefined): string {
  return (fp ?? '').replace(/\s+/g, '').toUpperCase();
}

function base64PublicKeysEqual(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  try {
    return constantTimeEqual(new Uint8Array(base64ToBuffer(a)), new Uint8Array(base64ToBuffer(b)));
  } catch {
    return false;
  }
}

export function identityBundleMatchesServer(
  bundle: { identityKey: string; signingKey: string; fingerprint: string },
  server: ServerIdentityState,
): boolean {
  return (
    normalizeFingerprint(bundle.fingerprint) === normalizeFingerprint(server.fingerprint) &&
    base64PublicKeysEqual(bundle.identityKey, server.identityKey) &&
    base64PublicKeysEqual(bundle.signingKey, server.signingKey)
  );
}

export async function fetchServerIdentityState(userId: string): Promise<ServerIdentityState | null> {
  const { data, error } = await supabase
    .from('user_public_keys')
    .select('identity_key, signing_key, fingerprint')
    .eq('user_id', userId)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    throw new IdentityServerUnavailableError(`Cannot read server identity: ${error.message}`);
  }

  if (!data?.identity_key || !data.signing_key || !data.fingerprint) return null;

  return {
    identityKey: data.identity_key,
    signingKey: data.signing_key,
    fingerprint: data.fingerprint,
  };
}

export async function fetchServerContinuityState(userId: string): Promise<ServerContinuityState> {
  const [publicKeysResult, backupsResult] = await Promise.all([
    supabase
      .from('user_public_keys')
      .select('identity_key, signing_key, fingerprint, is_active')
      .eq('user_id', userId)
      .order('is_active', { ascending: false })
      .limit(5),
    supabase
      .from('user_backups' as any)
      .select('id, backup_type')
      .eq('user_id', userId)
      .limit(5),
  ]);

  if (publicKeysResult.error) {
    throw new IdentityServerUnavailableError(`Cannot read server public-key continuity: ${publicKeysResult.error.message}`);
  }
  if (backupsResult.error) {
    throw new IdentityServerUnavailableError(`Cannot read server backup continuity: ${backupsResult.error.message}`);
  }

  const publicKeyRows = (publicKeysResult.data ?? []) as Array<{
    identity_key?: string | null;
    signing_key?: string | null;
    fingerprint?: string | null;
    is_active?: boolean | null;
  }>;
  const activeRow = publicKeyRows.find((row) =>
    row.is_active === true &&
    !!row.identity_key &&
    !!row.signing_key &&
    !!row.fingerprint,
  );
  const backupRows = (backupsResult.data ?? []) as Array<{ backup_type?: string | null }>;

  return {
    identity: activeRow
      ? {
          identityKey: activeRow.identity_key!,
          signingKey: activeRow.signing_key!,
          fingerprint: activeRow.fingerprint!,
        }
      : null,
    hasAnyPublicKey: publicKeyRows.length > 0,
    hasBackup: backupRows.length > 0,
    backupTypes: backupRows
      .map((row) => row.backup_type)
      .filter((type): type is string => typeof type === 'string'),
  };
}

async function exportBundleForLocalIdentity(
  userId: string,
  keys: IdentityKeyPair,
): Promise<{ identityKey: string; signingKey: string; fingerprint: string }> {
  try {
    return await exportPublicKeyBundle(keys);
  } catch {
    const storedBundle = await exportPublicKeyBundleFromStoredKeys(userId);
    if (!storedBundle) throw new Error('Stored identity bundle missing');
    return storedBundle;
  }
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot save identity keys: private key export failed (${message})`);
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
  cacheIdentity(userId, keys);
}

/** Load identity keys from IndexedDB — private keys are ALWAYS non-extractable */
export async function loadIdentityKeys(userId: string): Promise<IdentityKeyPair | null> {
  const cached = memCache.get(userId);
  if (isCompleteIdentityKeys(cached)) return cached;

  const stored = await dbGet<StoredKeyPair & { id: string }>(STORE_KEYS, userId);
  if (!stored) return null;

  const [publicKey, privateKey, signingPublicKey, signingPrivateKey] = await Promise.all([
    importKeyFromJWK(stored.publicKeyJWK, KX_KEY_PARAMS as any, [], true),     // public: exportable for server
    importKeyFromJWK(stored.privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], false), // PRIVATE: non-extractable
    importKeyFromJWK(stored.signingPublicKeyJWK, SIG_KEY_PARAMS as any, ['verify'], true),
    importKeyFromJWK(stored.signingPrivateKeyJWK, SIG_KEY_PARAMS as any, ['sign'], false), // PRIVATE: non-extractable
  ]);

  const keys = {
    publicKey,
    privateKey,
    signingPublicKey,
    signingPrivateKey,
    createdAt: stored.createdAt,
    fingerprint: stored.fingerprint,
  };
  cacheIdentity(userId, keys);
  return keys;
}

async function hasLocalWrappedIdentity(userId: string): Promise<boolean> {
  try {
    const { hasWrappedKeys } = await import('./pinWrap');
    return await hasWrappedKeys(userId);
  } catch {
    return false;
  }
}

async function fetchContinuityForIdentityCreation(userId: string): Promise<ServerContinuityState> {
  try {
    return await fetchServerContinuityState(userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new IdentityRestoreRequiredError(
      `Cannot verify server E2EE continuity; recovery required before creating a new identity (${message})`,
    );
  }
}

/**
 * Load the account E2EE identity using the server row as source of truth.
 *
 * If the server identity exists, this function only restores/validates local
 * key material. It never generates a replacement identity.
 *
 * If the server identity is missing, generation is allowed only for the
 * explicit FIRST_SETUP path (`allowCreate: true`).
 */
export async function getOrCreateIdentityKeys(
  userId: string,
  options: IdentityKeyLoadOptions = {},
): Promise<IdentityKeyPair & { isNewIdentity?: boolean }> {
  const continuity = await fetchContinuityForIdentityCreation(userId);
  const serverIdentity = continuity.identity;
  const existing = await loadIdentityKeys(userId);
  const hasWrapped = await hasLocalWrappedIdentity(userId);

  if (serverIdentity) {
    if (existing) {
      const bundle = await exportBundleForLocalIdentity(userId, existing);
      if (!identityBundleMatchesServer(bundle, serverIdentity)) {
        throw new IdentityFingerprintMismatchError(
          'Local identity does not match server fingerprint; E2EE is blocked until restore succeeds',
          serverIdentity.fingerprint,
          bundle.fingerprint,
        );
      }
      return existing;
    }

    if (hasWrapped) {
      console.log('[KEY_MGR] Server identity exists; raw keys missing and PIN-wrapped keys present');
      throw new PinUnlockRequiredError('PIN unlock required to recover identity keys');
    }

    console.warn('[KEY_MGR] Server identity exists but no local private identity is available');
    throw new IdentityRestoreRequiredError(
      'Server identity exists; restore encrypted E2EE vault before using messaging',
      serverIdentity.fingerprint,
    );
  }

  if (continuity.hasAnyPublicKey || continuity.hasBackup) {
    if (hasWrapped || continuity.backupTypes.includes('chat_pin')) {
      throw new PinUnlockRequiredError('PIN unlock required to recover existing E2EE identity');
    }
    throw new IdentityRestoreRequiredError(
      'Server E2EE continuity exists; restore encrypted E2EE vault before creating or publishing identity',
    );
  }

  if (existing) {
    if (!options.allowCreate) {
      throw new IdentityFirstSetupRequiredError('Server identity is missing; FIRST_SETUP must explicitly publish identity');
    }
    console.log('[KEY_MGR] Local unpublished identity found; treating as first setup material');
    return { ...existing, isNewIdentity: true };
  }

  if (hasWrapped) {
    throw new PinUnlockRequiredError('PIN unlock required to recover existing E2EE identity');
  }

  if (!options.allowCreate) {
    throw new IdentityFirstSetupRequiredError('Server identity is missing; FIRST_SETUP is required before crypto use');
  }

  console.log('[KEY_MGR] No server identity found - generating first E2EE identity');
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

/** Error thrown when the server identity exists but no private identity is locally restored */
export class IdentityRestoreRequiredError extends Error {
  constructor(message: string, public readonly serverFingerprint?: string) {
    super(message);
    this.name = 'IdentityRestoreRequiredError';
  }
}

/** Error thrown when local key material does not match the server identity */
export class IdentityFingerprintMismatchError extends Error {
  constructor(
    message: string,
    public readonly serverFingerprint?: string,
    public readonly localFingerprint?: string,
  ) {
    super(message);
    this.name = 'IdentityFingerprintMismatchError';
  }
}

/** Error thrown when the server identity decision cannot be read */
export class IdentityServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityServerUnavailableError';
  }
}

/** Error thrown when a caller tried to use crypto before FIRST_SETUP created server identity */
export class IdentityFirstSetupRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityFirstSetupRequiredError';
  }
}

export async function assertLocalIdentityMatchesServer(
  userId: string,
): Promise<{ server: ServerIdentityState | null; bundle: { identityKey: string; signingKey: string; fingerprint: string } | null }> {
  const server = await fetchServerIdentityState(userId);
  if (!server) return { server: null, bundle: null };

  const local = await loadIdentityKeys(userId);
  if (!local) {
    try {
      const { hasWrappedKeys } = await import('./pinWrap');
      if (await hasWrappedKeys(userId)) {
        throw new PinUnlockRequiredError('PIN unlock required to validate restored identity');
      }
    } catch (e) {
      if (e instanceof PinUnlockRequiredError) throw e;
    }
    throw new IdentityRestoreRequiredError('Server identity exists but local private identity is not restored', server.fingerprint);
  }

  const bundle = await exportBundleForLocalIdentity(userId, local);
  if (!identityBundleMatchesServer(bundle, server)) {
    throw new IdentityFingerprintMismatchError(
      'Restored identity fingerprint does not match server fingerprint',
      server.fingerprint,
      bundle.fingerprint,
    );
  }

  return { server, bundle };
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
    { name: 'AES-GCM', length: 256 },
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
  await runTxOn('e2ee', [STORE_KEYS, STORE_SESSION, STORE_PREKEYS], 'readwrite', (stores) => {
    stores[STORE_KEYS].clear();
    stores[STORE_SESSION].clear();
    stores[STORE_PREKEYS].clear();
  });
  clearIdentityMemoryCache();
}

/**
 * Wipe session keys, ratchet states and private prekeys from IndexedDB.
 * Called on PIN lock AFTER successful wrapping.
 */
export async function wipeSessionKeys(userId?: string): Promise<void> {
  try {
    await runTxOn('e2ee', STORE_SESSION, 'readwrite', (store) => {
      store.clear();
    });
  } catch (e) {
    console.warn('[KEY_MGR] Failed to clear session keys:', e);
  }

  try {
    await runTxOn('ratchet', 'ratchet-states', 'readwrite', (store) => {
      store.clear();
    });
  } catch (e) {
    console.warn('[KEY_MGR] Failed to clear ratchet states:', e);
  }

  console.log('[KEY_MGR] Session keys and ratchet states wiped');
}

/** Export all raw session key records from IndexedDB (for PIN wrapping) */
export async function exportAllSessionKeys(): Promise<StoredSessionKey[]> {
  try {
    return await runTxOn('e2ee', STORE_SESSION, 'readonly', (store) =>
      reqToPromise<StoredSessionKey[]>(store.getAll()),
    );
  } catch {
    return [];
  }
}

/** Import raw session key records into IndexedDB (from PIN unwrap) */
export async function importAllSessionKeys(records: StoredSessionKey[]): Promise<void> {
  if (!records.length) return;
  await runTxOn('e2ee', STORE_SESSION, 'readwrite', (store) => {
    for (const r of records) store.put(r);
  });
  console.log(`[KEY_MGR] ${records.length} session keys restored`);
}

/** Export all ratchet state records from IndexedDB (for PIN wrapping) */
export async function exportAllRatchetStates(): Promise<any[]> {
  try {
    return await runTxOn('ratchet', 'ratchet-states', 'readonly', (store) =>
      reqToPromise<any[]>(store.getAll()),
    );
  } catch {
    return [];
  }
}

/** Import ratchet state records into IndexedDB (from PIN unwrap) */
export async function importAllRatchetStates(records: any[]): Promise<void> {
  if (!records.length) return;
  try {
    await runTxOn('ratchet', 'ratchet-states', 'readwrite', (store) => {
      for (const r of records) store.put(r);
    });
    console.log(`[KEY_MGR] ${records.length} ratchet states restored`);
  } catch (e) {
    console.warn('[KEY_MGR] Failed to restore ratchet states:', e);
  }
}
