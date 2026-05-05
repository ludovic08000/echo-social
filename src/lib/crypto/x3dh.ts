/**
 * X3DH — Extended Triple Diffie-Hellman Key Agreement (Signal Protocol)
 * 
 * Implements the full X3DH handshake as specified by Signal:
 * https://signal.org/docs/specifications/x3dh/
 * 
 * Participants:
 *   Alice (initiator) has: IKa (identity key)
 *   Bob (responder) has:   IKb (identity key), SPKb (signed prekey), OPKb (one-time prekey)
 * 
 * X3DH computes:
 *   DH1 = DH(IKa, SPKb)     — Alice's identity ↔ Bob's signed prekey
 *   DH2 = DH(EKa, IKb)      — Alice's ephemeral ↔ Bob's identity
 *   DH3 = DH(EKa, SPKb)     — Alice's ephemeral ↔ Bob's signed prekey
 *   DH4 = DH(EKa, OPKb)     — Alice's ephemeral ↔ Bob's one-time prekey (optional)
 * 
 *   SK = KDF(DH1 || DH2 || DH3 [|| DH4])
 * 
 * PQXDH extension (future-ready):
 *   When ML-KEM-768 is available in browsers:
 *   (kemCT, kemSS) = KEM.Encapsulate(peerKyberPK)
 *   SK = KDF(DH1 || DH2 || DH3 [|| DH4] || kemSS)
 *   Both classical and PQ must be broken to compromise SK.
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import {
  bufferToBase64,
  base64ToBuffer,
  concatBuffers,
  encodeString,
  importKeyFromJWK,
  importOkpPublicKeyFromBase64,
} from './utils';
import {
  KX_KEY_PARAMS, SIG_KEY_PARAMS, HKDF_HASH,
  AES_ALGO, AES_KEY_LENGTH, PROTOCOL_VERSION,
} from './constants';
import { supabase } from '@/integrations/supabase/client';
import { type IdentityKeyPair, exportPublicKeyRaw } from './keyManager';

// ─── Types ───

export interface X3DHPrekeyBundle {
  /** Bob's identity public key (X25519, base64) */
  identityKey: string;
  /** Bob's signed prekey public (X25519, base64) */
  signedPrekey: string;
  /** Ed25519 signature over the signed prekey */
  signedPrekeySignature: string;
  /** Bob's signed prekey ID */
  signedPrekeyId: number;
  /** Bob's signing public key (Ed25519, base64) for sig verification */
  signingKey: string;
  /** Bob's one-time prekey (X25519, base64) — optional */
  oneTimePrekey?: string;
  /** One-time prekey ID — optional */
  oneTimePrekeyId?: number;
}

export interface X3DHResult {
  /** Shared secret (32 bytes) to seed Double Ratchet */
  sharedSecret: ArrayBuffer;
  /** Ephemeral public key (base64) — sent to Bob in initial message */
  ephemeralKey: string;
  /** Which one-time prekey was consumed (if any) */
  usedOTPKId?: number;
  /** Signed prekey ID used */
  usedSPKId: number;
  /** KEM ciphertext for PQXDH (future) */
  kemCiphertext?: string;
}

export interface X3DHInitialMessage {
  /** Alice's identity key (base64) */
  ik: string;
  /** Alice's ephemeral key (base64) */
  ek: string;
  /** Bob's signed prekey ID used */
  spkId: number;
  /** Bob's one-time prekey ID used (if any) */
  opkId?: number;
  /** KEM ciphertext (PQXDH future) */
  kemCt?: string;
}

// ─── X3DH Info string (domain separation) ───

const X3DH_INFO = 'ForSure-X3DH-v1';
const X3DH_SALT_BYTES = 32; // All zeros as per Signal spec

// ─── Signed Prekey Management ───

const SPK_ROTATION_DAYS = 7;
const SPK_DB_NAME = 'forsure-spk';
const SPK_DB_VERSION = 1;
const SPK_STORE = 'signed-prekeys';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_DEVICE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const B64_RE = /^[A-Za-z0-9+/_\-=]+$/;
const DB_KEY_FIELDS = new Set(['identity_key', 'signing_key', 'device_public_key', 'public_key', 'signature']);

function describeDBValue(field: string, value: unknown) {
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (typeof value !== 'string') return { field, type, value };
  return {
    field,
    type,
    length: value.length,
    preview: `${value.slice(0, 10)}${value.length > 10 ? '…' : ''}`,
    ...(DB_KEY_FIELDS.has(field) ? { redacted: 'public_key_truncated' } : { value }),
  };
}

function sanitizeDBPayload(payload: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(payload).map(([field, value]) => [field, describeDBValue(field, value)]));
}

function validatePayloadForDB(payload: Record<string, unknown>, tableName: 'device_signed_prekeys' | 'user_signed_prekeys'): void {
  const required = tableName === 'device_signed_prekeys'
    ? ['user_id', 'device_id', 'spk_id', 'public_key', 'signature', 'is_active']
    : ['user_id', 'spk_id', 'public_key', 'signature', 'is_active'];

  for (const [field, value] of Object.entries(payload)) {
    if (value === undefined) throw new Error(`[X3DH][DB][VALIDATION] ${tableName}.${field}: undefined interdit`);
  }
  for (const field of required) {
    if (payload[field] === null || payload[field] === undefined || payload[field] === '') {
      throw new Error(`[X3DH][DB][VALIDATION] ${tableName}.${field}: valeur obligatoire absente (${payload[field]})`);
    }
  }
  if (typeof payload.user_id !== 'string' || !UUID_RE.test(payload.user_id)) {
    throw new Error(`[X3DH][DB][VALIDATION] ${tableName}.user_id: UUID invalide (${JSON.stringify(describeDBValue('user_id', payload.user_id))})`);
  }
  if ('device_id' in payload && (typeof payload.device_id !== 'string' || !STABLE_DEVICE_ID_RE.test(payload.device_id))) {
    throw new Error(`[X3DH][DB][VALIDATION] ${tableName}.device_id: string stable invalide (${JSON.stringify(describeDBValue('device_id', payload.device_id))})`);
  }
  if (typeof payload.spk_id !== 'number' || !Number.isInteger(payload.spk_id) || payload.spk_id <= 0) {
    throw new Error(`[X3DH][DB][VALIDATION] ${tableName}.spk_id: integer positif invalide (${payload.spk_id})`);
  }
  for (const field of ['public_key', 'signature']) {
    if (typeof payload[field] !== 'string' || !B64_RE.test(payload[field] as string)) {
      throw new Error(`[X3DH][DB][VALIDATION] ${tableName}.${field}: base64 string invalide (${JSON.stringify(describeDBValue(field, payload[field]))})`);
    }
  }
}

function logDBPayloadBeforeUpsert(table: 'device_signed_prekeys' | 'user_signed_prekeys', payload: Record<string, unknown>) {
  console.log('[X3DH][DB][UPSERT_PAYLOAD]', {
    table,
    payload_keys: Object.keys(payload),
    fields: sanitizeDBPayload(payload),
  });
}

function logDBUpsertError(table: 'device_signed_prekeys' | 'user_signed_prekeys', step: string, error: any, payload: Record<string, unknown>) {
  const haystack = [error?.message, error?.details, error?.hint].filter(Boolean).join(' ');
  const rejectedColumn = Object.keys(payload).find((key) => new RegExp(`\\b${key}\\b`, 'i').test(haystack));
  const diagnostic = {
    table,
    step,
    code: error?.code,
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
    rejected_column: rejectedColumn ?? 'unknown_from_supabase_error',
    rejected_value: rejectedColumn ? describeDBValue(rejectedColumn, payload[rejectedColumn]) : undefined,
    payload_keys: Object.keys(payload),
    payload: sanitizeDBPayload(payload),
  };
  console.error('[X3DH][DB][UPSERT_FAIL]', diagnostic);
  return diagnostic;
}

function openSPKDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = hardGlobals.idbOpen(SPK_DB_NAME, SPK_DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SPK_STORE)) {
        db.createObjectStore(SPK_STORE, { keyPath: 'id' });
      }
    };
  });
}

interface StoredSPK {
  id: string; // `${userId}:${spkId}`
  spkId: number;
  privateKeyJWK: JsonWebKey;
  publicKeyBase64: string;
  createdAt: number;
}

async function saveSPKPrivate(userId: string, spkId: number, privateKey: CryptoKey, publicBase64: string): Promise<void> {
  const jwk = await hardCrypto.exportKey('jwk', privateKey);
  const db = await openSPKDB();
  const tx = db.transaction(SPK_STORE, 'readwrite');
  tx.objectStore(SPK_STORE).put({
    id: `${userId}:${spkId}`,
    spkId,
    privateKeyJWK: jwk,
    publicKeyBase64: publicBase64,
    createdAt: Date.now(),
  } as StoredSPK);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadSPKPrivate(userId: string, spkId: number): Promise<CryptoKey | null> {
  try {
    const db = await openSPKDB();
    const tx = db.transaction(SPK_STORE, 'readonly');
    const req = tx.objectStore(SPK_STORE).get(`${userId}:${spkId}`);
    const result = await new Promise<StoredSPK | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!result) return null;
    return importKeyFromJWK(result.privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], false);
  } catch {
    return null;
  }
}

/**
 * Load a stored SPK record (both private key + public base64).
 * Returns null if not found.
 */
async function loadSPKRecord(userId: string, spkId: number): Promise<StoredSPK | null> {
  try {
    const db = await openSPKDB();
    const tx = db.transaction(SPK_STORE, 'readonly');
    const req = tx.objectStore(SPK_STORE).get(`${userId}:${spkId}`);
    const result = await new Promise<StoredSPK | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return result ?? null;
  } catch {
    return null;
  }
}

async function getNextSPKId(userId: string): Promise<number> {
  try {
    const db = await openSPKDB();
    const tx = db.transaction(SPK_STORE, 'readonly');
    const allKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = tx.objectStore(SPK_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const prefix = `${userId}:`;
    let maxId = 0;
    for (const key of allKeys) {
      const k = String(key);
      if (k.startsWith(prefix)) {
        const id = parseInt(k.slice(prefix.length), 10);
        if (id > maxId) maxId = id;
      }
    }
    return maxId + 1;
  } catch {
    return 1;
  }
}

/**
 * Generate a new signed prekey and upload to server.
 * The SPK is an X25519 key signed by the user's Ed25519 identity key.
 */
export async function generateAndUploadSignedPrekey(
  userId: string,
  signingPrivateKey: CryptoKey,
): Promise<{ spkId: number; publicKey: string; signature: string }> {
  const spkId = await getNextSPKId(userId);

  // Generate X25519 key pair for SPK
  const spkPair = await hardCrypto.generateKey(
    KX_KEY_PARAMS as any, true, ['deriveBits'],
  ) as CryptoKeyPair;

  const publicRaw = await exportPublicKeyRaw(spkPair.publicKey);
  const publicBase64 = bufferToBase64(publicRaw);

  // Sign the SPK public key with Ed25519 identity key
  const signature = await hardCrypto.sign(
    'Ed25519' as any,
    signingPrivateKey,
    publicRaw,
  );
  const signatureBase64 = bufferToBase64(signature);

  // Store private half locally
  await saveSPKPrivate(userId, spkId, spkPair.privateKey, publicBase64);

  const payload = {
    user_id: userId,
    spk_id: spkId,
    public_key: publicBase64,
    signature: signatureBase64,
    is_active: true,
  };
  validatePayloadForDB(payload, 'user_signed_prekeys');
  logDBPayloadBeforeUpsert('user_signed_prekeys', payload);

  // Upload to server
  const { error } = await supabase
    .from('user_signed_prekeys')
    .upsert(payload, { onConflict: 'user_id,spk_id' });

  if (error) {
    const dbDiag = logDBUpsertError('user_signed_prekeys', 'user_signed_prekeys_upsert', error, payload);
    throw new Error(`X3DH_DB_UPSERT_FAILED table=user_signed_prekeys step=user_signed_prekeys_upsert code=${dbDiag.code ?? 'n/a'} rejected_column=${dbDiag.rejected_column} details=${dbDiag.details ?? 'n/a'} hint=${dbDiag.hint ?? 'n/a'} supabase_message=${dbDiag.message ?? 'n/a'}`);
  }

  // Deactivate previous SPKs on server but keep local private keys
  // (old SPKs may still be referenced by in-flight X3DH messages)
  await supabase
    .from('user_signed_prekeys')
    .update({ is_active: false })
    .eq('user_id', userId)
    .neq('spk_id', spkId);

  console.log(`[X3DH] ✅ Signed prekey #${spkId} generated & uploaded`);
  return { spkId, publicKey: publicBase64, signature: signatureBase64 };
}

/**
 * Check if signed prekey needs rotation (every 7 days) and regenerate if so.
 */
export async function refreshSignedPrekeyIfNeeded(
  userId: string,
  signingPrivateKey: CryptoKey,
): Promise<void> {
  try {
    const { data } = await supabase
      .from('user_signed_prekeys')
      .select('created_at, public_key, signature, spk_id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) {
      console.info('[X3DH] No active SPK found — generating first one');
      await generateAndUploadSignedPrekey(userId, signingPrivateKey);
      return;
    }

    // Verify that the existing SPK signature matches the CURRENT signing key.
    // If identity keys were regenerated, the old SPK signature won't verify
    // against the new signing key → must regenerate SPK.
    let signatureValid = false;
    try {
      const spkRaw = base64ToBuffer(data.public_key);
      const sigRaw = base64ToBuffer(data.signature);

      const { data: pubKeyData } = await supabase
        .from('user_public_keys')
        .select('signing_key')
        .eq('user_id', userId)
        .eq('is_active', true)
        .maybeSingle();

      if (pubKeyData) {
        const signingPubKey = await importEd25519Public(pubKeyData.signing_key);
        signatureValid = await hardCrypto.verify(
          'Ed25519' as any, signingPubKey, sigRaw, spkRaw,
        );
      }

      if (!signatureValid) {
        console.warn('[X3DH] ⚠️ SPK signature verification FAILED against current signing key — SPK out of sync');
      }
    } catch (verifyErr) {
      console.warn('[X3DH] ⚠️ SPK signature verification error:', verifyErr);
      signatureValid = false;
    }

    if (!signatureValid) {
      console.info('[X3DH] Active signed prekey out of sync with current signing key — regenerating');
      await generateAndUploadSignedPrekey(userId, signingPrivateKey);
      return;
    }

    // Verify local private half exists for this SPK
    const localRecord = await loadSPKRecord(userId, data.spk_id);
    if (!localRecord) {
      console.warn(`[X3DH] ⚠️ SPK #${data.spk_id} active on server but private key MISSING locally — regenerating`);
      await generateAndUploadSignedPrekey(userId, signingPrivateKey);
      return;
    }

    const ageMs = Date.now() - new Date(data.created_at).getTime();
    if (ageMs > SPK_ROTATION_DAYS * 24 * 60 * 60 * 1000) {
      console.log('[X3DH] SPK expired, rotating...');
      await generateAndUploadSignedPrekey(userId, signingPrivateKey);
    }
  } catch (e) {
    console.error('[X3DH] SPK refresh check failed:', e);
  }
}

// ─── Per-device Signed PreKey (multi-device extension) ───
//
// Strictly additive layer on top of the per-user SPK system.
// Each device of the same user maintains its own SPK so that a fan-out
// initiator can perform a fresh X3DH targeted at one specific device.
// The shared identity key (IK) is reused across devices (hybrid model).

/** IDB record key for a device-scoped SPK */
function deviceSpkKey(userId: string, deviceId: string, spkId: number): string {
  return `${userId}::dev::${deviceId}::${spkId}`;
}

async function saveDeviceSPKPrivate(
  userId: string,
  deviceId: string,
  spkId: number,
  privateKey: CryptoKey,
  publicBase64: string,
): Promise<void> {
  const jwk = await hardCrypto.exportKey('jwk', privateKey);
  const db = await openSPKDB();
  const tx = db.transaction(SPK_STORE, 'readwrite');
  tx.objectStore(SPK_STORE).put({
    id: deviceSpkKey(userId, deviceId, spkId),
    spkId,
    privateKeyJWK: jwk,
    publicKeyBase64: publicBase64,
    createdAt: Date.now(),
  } as StoredSPK);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadDeviceSPKRecord(
  userId: string,
  deviceId: string,
  spkId: number,
): Promise<StoredSPK | null> {
  try {
    const db = await openSPKDB();
    const tx = db.transaction(SPK_STORE, 'readonly');
    const req = tx.objectStore(SPK_STORE).get(deviceSpkKey(userId, deviceId, spkId));
    const result = await new Promise<StoredSPK | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return result ?? null;
  } catch {
    return null;
  }
}

async function getNextDeviceSPKId(userId: string, deviceId: string): Promise<number> {
  try {
    const db = await openSPKDB();
    const tx = db.transaction(SPK_STORE, 'readonly');
    const allKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = tx.objectStore(SPK_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const prefix = `${userId}::dev::${deviceId}::`;
    let maxId = 0;
    for (const key of allKeys) {
      const k = String(key);
      if (k.startsWith(prefix)) {
        const id = parseInt(k.slice(prefix.length), 10);
        if (!Number.isNaN(id) && id > maxId) maxId = id;
      }
    }
    return maxId + 1;
  } catch {
    return 1;
  }
}

/**
 * Generate and publish a Signed PreKey scoped to ONE device.
 * Backed by the new `device_signed_prekeys` table — the legacy per-user SPK
 * system continues to work unchanged for mono-device flows.
 */
export async function generateAndUploadDeviceSignedPrekey(
  userId: string,
  deviceId: string,
  signingPrivateKey: CryptoKey,
): Promise<{ spkId: number; publicKey: string; signature: string }> {
  const spkId = await getNextDeviceSPKId(userId, deviceId);

  const spkPair = await hardCrypto.generateKey(
    KX_KEY_PARAMS as any, true, ['deriveBits'],
  ) as CryptoKeyPair;

  const publicRaw = await exportPublicKeyRaw(spkPair.publicKey);
  const publicBase64 = bufferToBase64(publicRaw);

  const signature = await hardCrypto.sign('Ed25519' as any, signingPrivateKey, publicRaw);
  const signatureBase64 = bufferToBase64(signature);

  await saveDeviceSPKPrivate(userId, deviceId, spkId, spkPair.privateKey, publicBase64);

  const payload = {
    user_id: userId,
    device_id: deviceId,
    spk_id: spkId,
    public_key: publicBase64,
    signature: signatureBase64,
    is_active: true,
  };
  validatePayloadForDB(payload, 'device_signed_prekeys');
  logDBPayloadBeforeUpsert('device_signed_prekeys', payload);

  const { error } = await supabase
    .from('device_signed_prekeys')
    .upsert(payload, { onConflict: 'user_id,device_id,spk_id' });

  if (error) {
    const dbDiag = logDBUpsertError('device_signed_prekeys', 'device_signed_prekeys_upsert', error, payload);
    throw new Error(`X3DH_DB_UPSERT_FAILED table=device_signed_prekeys step=device_signed_prekeys_upsert code=${dbDiag.code ?? 'n/a'} rejected_column=${dbDiag.rejected_column} details=${dbDiag.details ?? 'n/a'} hint=${dbDiag.hint ?? 'n/a'} supabase_message=${dbDiag.message ?? 'n/a'}`);
  }

  // Deactivate previous device SPKs server-side (local privates kept for in-flight)
  await supabase
    .from('device_signed_prekeys')
    .update({ is_active: false })
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .neq('spk_id', spkId);

  console.log(`[X3DH-DEV] ✅ device SPK #${spkId} for ${deviceId.slice(0, 8)}… uploaded`);
  return { spkId, publicKey: publicBase64, signature: signatureBase64 };
}

/**
 * Refresh the device SPK if missing or older than 7 days.
 * Safe to call on every login.
 */
export async function refreshDeviceSignedPrekeyIfNeeded(
  userId: string,
  deviceId: string,
  signingPrivateKey: CryptoKey,
): Promise<void> {
  try {
    const { data } = await supabase
      .from('device_signed_prekeys')
      .select('created_at, expires_at, spk_id')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data) {
      await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey);
      return;
    }

    const local = await loadDeviceSPKRecord(userId, deviceId, data.spk_id);
    if (!local) {
      console.warn('[X3DH-DEV] active device SPK missing locally → regenerating');
      await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey);
      return;
    }

    const now = Date.now();
    const ageMs = now - new Date(data.created_at).getTime();
    const expiresAtMs = data.expires_at ? new Date(data.expires_at).getTime() : Infinity;
    const expiresInMs = expiresAtMs - now;
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

    // Rotate if EITHER:
    //   - local age > 7 days (proactive weekly rotation), OR
    //   - server expires_at is within 7 days (defense-in-depth)
    if (ageMs > SPK_ROTATION_DAYS * 24 * 60 * 60 * 1000 || expiresInMs < SEVEN_DAYS_MS) {
      console.log(
        `[X3DH-DEV] rotating device SPK (age=${Math.round(ageMs / 86400000)}d, expiresIn=${Math.round(expiresInMs / 86400000)}d)`,
      );
      await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey);
    }
  } catch (e) {
    console.warn('[X3DH-DEV] device SPK refresh failed (non-fatal):', e);
  }
}

// ─── Per-device One-Time PreKeys (OPK) ───
//
// One-shot keys consumed atomically by the server (`claim_device_one_time_prekey`)
// to guarantee fresh forward secrecy: two senders to the same device in the same
// window will get different OPKs → different shared secrets.
// Pool is refilled in batches of OPK_BATCH_SIZE when count drops below OPK_LOW_THRESHOLD.

const OPK_BATCH_SIZE = 50;
const OPK_LOW_THRESHOLD = 10;

function deviceOPKKey(userId: string, deviceId: string, opkId: number): string {
  return `${userId}::dev::${deviceId}::opk::${opkId}`;
}

async function saveDeviceOPKPrivate(
  userId: string,
  deviceId: string,
  opkId: number,
  privateKey: CryptoKey,
  publicBase64: string,
): Promise<void> {
  const jwk = await hardCrypto.exportKey('jwk', privateKey);
  const db = await openSPKDB();
  const tx = db.transaction(SPK_STORE, 'readwrite');
  tx.objectStore(SPK_STORE).put({
    id: deviceOPKKey(userId, deviceId, opkId),
    spkId: opkId,
    privateKeyJWK: jwk,
    publicKeyBase64: publicBase64,
    createdAt: Date.now(),
  } as StoredSPK);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadDeviceOPKPrivate(
  userId: string,
  deviceId: string,
  opkId: number,
): Promise<CryptoKey | null> {
  try {
    const db = await openSPKDB();
    const tx = db.transaction(SPK_STORE, 'readonly');
    const req = tx.objectStore(SPK_STORE).get(deviceOPKKey(userId, deviceId, opkId));
    const result = await new Promise<StoredSPK | undefined>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (!result) return null;
    return importKeyFromJWK(result.privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], false);
  } catch {
    return null;
  }
}

async function deleteDeviceOPKPrivate(userId: string, deviceId: string, opkId: number): Promise<void> {
  try {
    const db = await openSPKDB();
    const tx = db.transaction(SPK_STORE, 'readwrite');
    tx.objectStore(SPK_STORE).delete(deviceOPKKey(userId, deviceId, opkId));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* non-fatal */ }
}

async function getNextDeviceOPKBaseId(userId: string, deviceId: string): Promise<number> {
  try {
    const db = await openSPKDB();
    const tx = db.transaction(SPK_STORE, 'readonly');
    const allKeys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = tx.objectStore(SPK_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const prefix = `${userId}::dev::${deviceId}::opk::`;
    let maxId = 0;
    for (const key of allKeys) {
      const k = String(key);
      if (k.startsWith(prefix)) {
        const id = parseInt(k.slice(prefix.length), 10);
        if (!Number.isNaN(id) && id > maxId) maxId = id;
      }
    }
    return maxId + 1;
  } catch {
    return 1;
  }
}

/**
 * Refill the device's One-Time PreKey pool if it's running low.
 * Generates OPK_BATCH_SIZE new X25519 keypairs, stores privates locally,
 * and publishes publics to `device_one_time_prekeys`.
 * Safe to call on every login — it's a no-op when pool is healthy.
 */
export async function refillDeviceOneTimePrekeysIfNeeded(
  userId: string,
  deviceId: string,
): Promise<void> {
  try {
    const { data: count, error: countErr } = await supabase
      .rpc('count_device_one_time_prekeys', { p_user_id: userId, p_device_id: deviceId });
    if (countErr) {
      console.warn('[X3DH-OPK] count failed:', countErr.message);
      return;
    }
    const available = (count as unknown as number) ?? 0;
    if (available >= OPK_LOW_THRESHOLD) return;

    console.log(`[X3DH-OPK] pool low (${available}/${OPK_LOW_THRESHOLD}) → refilling +${OPK_BATCH_SIZE}`);
    const baseId = await getNextDeviceOPKBaseId(userId, deviceId);
    const rows: Array<{ user_id: string; device_id: string; opk_id: number; public_key: string }> = [];

    for (let i = 0; i < OPK_BATCH_SIZE; i++) {
      const opkId = baseId + i;
      const pair = await hardCrypto.generateKey(
        KX_KEY_PARAMS as any, true, ['deriveBits'],
      ) as CryptoKeyPair;
      const pubRaw = await exportPublicKeyRaw(pair.publicKey);
      const pubB64 = bufferToBase64(pubRaw);
      await saveDeviceOPKPrivate(userId, deviceId, opkId, pair.privateKey, pubB64);
      rows.push({ user_id: userId, device_id: deviceId, opk_id: opkId, public_key: pubB64 });
    }

    const { error: insErr } = await supabase
      .from('device_one_time_prekeys')
      .insert(rows as any);
    if (insErr) {
      console.error('[X3DH-OPK] batch insert failed:', insErr.message);
      return;
    }
    console.log(`[X3DH-OPK] ✅ ${OPK_BATCH_SIZE} new OPKs published for ${deviceId.slice(0, 8)}…`);
  } catch (e) {
    console.warn('[X3DH-OPK] refill failed (non-fatal):', e);
  }
}

/** Atomically claim ONE OPK published by the peer device. Returns null if pool empty. */
async function claimPeerDeviceOPK(
  peerUserId: string,
  peerDeviceId: string,
): Promise<{ opkId: number; publicKey: string } | null> {
  try {
    const { data, error } = await supabase
      .rpc('claim_device_one_time_prekey', { p_user_id: peerUserId, p_device_id: peerDeviceId });
    if (error || !data || (data as any[]).length === 0) return null;
    const row = (data as any[])[0];
    return { opkId: row.opk_id as number, publicKey: row.public_key as string };
  } catch {
    return null;
  }
}

async function fetchDevicePrekeyMaterial(
  peerUserId: string,
  peerDeviceId: string,
): Promise<{
  identityKey: string;
  signingKey: string;
  spkId: number;
  publicKey: string;
  signature: string;
} | null> {
  const { data: pubKeys } = await supabase
    .from('user_public_keys')
    .select('identity_key, signing_key')
    .eq('user_id', peerUserId)
    .eq('is_active', true)
    .maybeSingle();
  if (!pubKeys) return null;

  const { data: spkRows, error } = await supabase
    .rpc('get_device_prekey_bundle', { p_user_id: peerUserId, p_device_id: peerDeviceId });
  if (error || !spkRows || spkRows.length === 0) return null;

  const spk = spkRows[0] as { spk_id: number; public_key: string; signature: string };
  return {
    identityKey: pubKeys.identity_key,
    signingKey: pubKeys.signing_key,
    spkId: spk.spk_id,
    publicKey: spk.public_key,
    signature: spk.signature,
  };
}

async function verifySignedPrekey(
  signingKeyB64: string,
  spkPublicB64: string,
  signatureB64: string,
): Promise<boolean> {
  try {
    const peerSigningKey = await importEd25519Public(signingKeyB64);
    return await hardCrypto.verify(
      'Ed25519' as any,
      peerSigningKey,
      base64ToBuffer(signatureB64),
      base64ToBuffer(spkPublicB64),
    );
  } catch (e) {
    console.warn('[X3DH] SPK signature check error:', e);
    return false;
  }
}

/**
 * Read active device SPK metadata without consuming an OPK.
 * This mirrors Sesame's "prep" step: inspect current device state first, and
 * only claim one-time prekeys when a fresh X3DH initiation is really needed.
 */
export async function peekDeviceSignedPrekey(
  peerUserId: string,
  peerDeviceId: string,
): Promise<{ signedPrekeyId: number } | null> {
  const material = await fetchDevicePrekeyMaterial(peerUserId, peerDeviceId);
  if (!material) return null;

  const sigValid = await verifySignedPrekey(material.signingKey, material.publicKey, material.signature);
  if (!sigValid) {
    console.warn(`[X3DH-DEV] device SPK signature INVALID for ${peerUserId}/${peerDeviceId}`);
    return null;
  }

  return { signedPrekeyId: material.spkId };
}

/**
 * Fetch a per-DEVICE prekey bundle (multi-device fan-out path).
 * Returns null if the target device has not yet published a SPK — caller should
 * fall back to the legacy per-user bundle or to deviceWrap.
 */
export async function fetchPrekeyBundleForDevice(
  peerUserId: string,
  peerDeviceId: string,
): Promise<X3DHPrekeyBundle | null> {
  const material = await fetchDevicePrekeyMaterial(peerUserId, peerDeviceId);
  if (!material) return null;

  const sigValid = await verifySignedPrekey(material.signingKey, material.publicKey, material.signature);
  if (!sigValid) {
    console.warn(`[X3DH-DEV] ⛔ device SPK signature INVALID for ${peerUserId}/${peerDeviceId}`);
    return null;
  }

  // 4. Try to atomically claim ONE OPK from the peer device's pool.
  //    If pool is empty, X3DH falls back to 3-DH (no DH4) — secure but
  //    less forward-secrecy on bursts of messages within the same window.
  const opk = await claimPeerDeviceOPK(peerUserId, peerDeviceId);
  if (opk) {
    console.log(`[X3DH-DEV] 🔑 claimed OPK #${opk.opkId} for ${peerDeviceId.slice(0, 8)}…`);
  }

  return {
    identityKey: material.identityKey,
    signingKey: material.signingKey,
    signedPrekey: material.publicKey,
    signedPrekeySignature: material.signature,
    signedPrekeyId: material.spkId,
    oneTimePrekey: opk?.publicKey,
    oneTimePrekeyId: opk?.opkId,
  };
}

// ─── X3DH Initiator (Alice) ───

/**
 * Fetch Bob's prekey bundle from the server (LEGACY per-user path).
 * Validates bundle coherence before returning.
 */
export async function fetchPrekeyBundle(peerUserId: string): Promise<X3DHPrekeyBundle | null> {
  // 1. Get identity key + signing key
  const { data: pubKeys } = await supabase
    .from('user_public_keys')
    .select('identity_key, signing_key')
    .eq('user_id', peerUserId)
    .eq('is_active', true)
    .maybeSingle();

  if (!pubKeys) {
    console.warn('[X3DH] fetchPrekeyBundle: peer has no public keys:', peerUserId);
    return null;
  }

  // 2. Get active signed prekey
  const { data: spkData } = await supabase
    .rpc('get_signed_prekey', { p_user_id: peerUserId });

  if (!spkData || spkData.length === 0) {
    console.warn('[X3DH] fetchPrekeyBundle: peer has no signed prekey:', peerUserId);
    return null;
  }

  const spk = spkData[0];

  // 3. Verify SPK signature BEFORE consuming any OPK
  // This prevents wasting a one-time prekey on a stale/invalid bundle
  let sigValid = false;
  try {
    const spkRaw = base64ToBuffer(spk.public_key);
    const sigRaw = base64ToBuffer(spk.signature);
    const peerSigningKey = await importEd25519Public(pubKeys.signing_key);
    sigValid = await hardCrypto.verify('Ed25519' as any, peerSigningKey, sigRaw, spkRaw);
  } catch (verifyErr) {
    console.error('[X3DH] ⚠️ SPK signature verification error in fetchPrekeyBundle:', verifyErr);
  }

  if (!sigValid) {
    console.error(`[X3DH] ⛔ SPK #${spk.spk_id} signature INVALID for peer ${peerUserId} — bundle REJECTED (possible stale SPK or signing key mismatch)`);
    return null;
  }

  // OPK system removed — X3DH now always uses the 3-DH variant.
  return {
    identityKey: pubKeys.identity_key,
    signingKey: pubKeys.signing_key,
    signedPrekey: spk.public_key,
    signedPrekeySignature: spk.signature,
    signedPrekeyId: spk.spk_id,
    oneTimePrekey: undefined,
    oneTimePrekeyId: undefined,
  };
}

/**
 * Perform X3DH as the initiator (Alice).
 * 
 * Generates an ephemeral key, performs 3 or 4 DH operations,
 * and derives a shared secret for Double Ratchet initialization.
 */
export async function x3dhInitiate(
  myKeys: IdentityKeyPair,
  bundle: X3DHPrekeyBundle,
): Promise<X3DHResult> {
  // 1. Signature already verified in fetchPrekeyBundle, but double-check
  const spkRaw = base64ToBuffer(bundle.signedPrekey);
  const sigRaw = base64ToBuffer(bundle.signedPrekeySignature);
  const peerSigningKey = await importEd25519Public(bundle.signingKey);

  const sigValid = await hardCrypto.verify(
    'Ed25519' as any, peerSigningKey, sigRaw, spkRaw,
  );

  if (!sigValid) {
    throw new Error('X3DH: Signed prekey signature verification FAILED — possible MITM');
  }

  // 2. Import peer keys
  const peerIK = await importX25519Public(bundle.identityKey);
  const peerSPK = await importX25519Public(bundle.signedPrekey);

  // 3. Generate ephemeral key pair (EKa)
  const ephemeralPair = await hardCrypto.generateKey(
    KX_KEY_PARAMS as any, true, ['deriveBits'],
  ) as CryptoKeyPair;

  const ephPubRaw = await exportPublicKeyRaw(ephemeralPair.publicKey);
  const ephemeralKey = bufferToBase64(ephPubRaw);

  // 4. Compute DH operations
  // DH1 = DH(IKa_priv, SPKb_pub)
  const dh1 = await hardCrypto.deriveBits(
    { name: 'X25519', public: peerSPK } as any,
    myKeys.privateKey,
    256,
  );

  // DH2 = DH(EKa_priv, IKb_pub)
  const dh2 = await hardCrypto.deriveBits(
    { name: 'X25519', public: peerIK } as any,
    ephemeralPair.privateKey,
    256,
  );

  // DH3 = DH(EKa_priv, SPKb_pub)
  const dh3 = await hardCrypto.deriveBits(
    { name: 'X25519', public: peerSPK } as any,
    ephemeralPair.privateKey,
    256,
  );

  // DH4 = DH(EKa_priv, OPKb_pub) — optional
  let dh4: ArrayBuffer | null = null;
  if (bundle.oneTimePrekey) {
    const peerOPK = await importX25519Public(bundle.oneTimePrekey);
    dh4 = await hardCrypto.deriveBits(
      { name: 'X25519', public: peerOPK } as any,
      ephemeralPair.privateKey,
      256,
    );
  }

  // 5. Combine DH outputs: SK = KDF(F || DH1 || DH2 || DH3 [|| DH4])
  // F = 0xFF * 32 bytes (as per Signal X3DH spec for domain separation)
  const filler = new Uint8Array(32).fill(0xFF);
  const dhConcat = dh4
    ? concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3, dh4)
    : concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3);

  // 6. HKDF to derive final shared secret
  const sharedSecret = await x3dhKDF(dhConcat);

  console.log(`[X3DH] ✅ Initiated with ${dh4 ? '4' : '3'} DH operations (SPK #${bundle.signedPrekeyId}${bundle.oneTimePrekeyId ? `, OPK #${bundle.oneTimePrekeyId}` : ''})`);

  return {
    sharedSecret,
    ephemeralKey,
    usedOTPKId: bundle.oneTimePrekeyId,
    usedSPKId: bundle.signedPrekeyId,
  };
}

// ─── X3DH Responder (Bob) ───

/**
 * Perform X3DH as the responder (Bob).
 * 
 * Bob receives Alice's initial message header and computes the same shared secret.
 * Returns the shared secret AND Bob's SPK key pair for Double Ratchet init.
 */
export async function x3dhRespond(
  myKeys: IdentityKeyPair,
  myUserId: string,
  initialMessage: X3DHInitialMessage,
): Promise<{ sharedSecret: ArrayBuffer; spkKeyPair: CryptoKeyPair }> {
  console.info(`[X3DH] init responder — SPK #${initialMessage.spkId}, OPK ${initialMessage.opkId ?? 'none'}, peer IK ${initialMessage.ik.slice(0, 8)}…`);

  // 1. Import Alice's keys
  const aliceIK = await importX25519Public(initialMessage.ik);
  const aliceEK = await importX25519Public(initialMessage.ek);

  // 2. Load our signed prekey record (private + public) — MUST exist
  const spkRecord = await loadSPKRecord(myUserId, initialMessage.spkId);
  if (!spkRecord) {
    const errMsg = `[X3DH] ⛔ SPK #${initialMessage.spkId} NOT FOUND locally for user ${myUserId} — cannot complete X3DH handshake. The signed prekey may have been rotated or the local store was cleared.`;
    console.error(errMsg);
    throw new Error(errMsg);
  }

  console.info(`[X3DH] SPK #${initialMessage.spkId} loaded — public=${spkRecord.publicKeyBase64.slice(0, 12)}…`);

  const spkPrivate = await importKeyFromJWK(
    spkRecord.privateKeyJWK,
    KX_KEY_PARAMS as any,
    ['deriveBits'],
    true, // extractable: needed for CryptoKeyPair usage in ratchet
  );

  const spkPublic = await importX25519Public(spkRecord.publicKeyBase64);

  // 3. Compute DH operations (Bob's perspective, reversed)
  // DH1 = DH(SPKb_priv, IKa_pub)
  const dh1 = await hardCrypto.deriveBits(
    { name: 'X25519', public: aliceIK } as any,
    spkPrivate,
    256,
  );

  // DH2 = DH(IKb_priv, EKa_pub)
  const dh2 = await hardCrypto.deriveBits(
    { name: 'X25519', public: aliceEK } as any,
    myKeys.privateKey,
    256,
  );

  // DH3 = DH(SPKb_priv, EKa_pub)
  const dh3 = await hardCrypto.deriveBits(
    { name: 'X25519', public: aliceEK } as any,
    spkPrivate,
    256,
  );

  // OPK / DH4 removed — handshake is now strictly 3-DH.
  if (initialMessage.opkId !== undefined) {
    console.warn(`[X3DH] Ignoring legacy OPK #${initialMessage.opkId} on incoming message — 3-DH only mode`);
  }

  const filler = new Uint8Array(32).fill(0xFF);
  const dhConcat = concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3);

  const sharedSecret = await x3dhKDF(dhConcat);

  console.info(`[X3DH] ✅ Responded with 3 DH operations (SPK #${initialMessage.spkId})`);

  // Return the SPK key pair so the responder can use it as initial ratchet DH pair
  // Per Signal spec: Bob's SPK serves as his initial ratchet key — NO new random DH pair here
  return {
    sharedSecret,
    spkKeyPair: { publicKey: spkPublic, privateKey: spkPrivate },
  };
}

// ─── Per-device responder (multi-device fan-out path) ───
//
// Mirror of x3dhRespond, but loads the DEVICE-SCOPED SPK private (not the per-user one)
// and optionally consumes the matching OPK private for full 4-DH forward secrecy.
// Used exclusively by multiDeviceFanout.ts — does NOT touch the legacy per-user flow.
export async function x3dhRespondForDevice(
  myKeys: IdentityKeyPair,
  myUserId: string,
  myDeviceId: string,
  initialMessage: X3DHInitialMessage,
): Promise<{ sharedSecret: ArrayBuffer; spkKeyPair: CryptoKeyPair }> {
  console.info(
    `[X3DH-DEV] respond — SPK #${initialMessage.spkId}, OPK ${initialMessage.opkId ?? 'none'}, dev=${myDeviceId.slice(0, 8)}…`,
  );

  const aliceIK = await importX25519Public(initialMessage.ik);
  const aliceEK = await importX25519Public(initialMessage.ek);

  // Load DEVICE-SCOPED SPK record (not per-user)
  const spkRecord = await loadDeviceSPKRecord(myUserId, myDeviceId, initialMessage.spkId);
  if (!spkRecord) {
    throw new Error(
      `[X3DH-DEV] device SPK #${initialMessage.spkId} NOT FOUND for ${myDeviceId.slice(0, 8)}…`,
    );
  }

  const spkPrivate = await importKeyFromJWK(
    spkRecord.privateKeyJWK,
    KX_KEY_PARAMS as any,
    ['deriveBits'],
    true,
  );
  const spkPublic = await importX25519Public(spkRecord.publicKeyBase64);

  // DH1..DH3 — Bob's perspective
  const dh1 = await hardCrypto.deriveBits(
    { name: 'X25519', public: aliceIK } as any, spkPrivate, 256,
  );
  const dh2 = await hardCrypto.deriveBits(
    { name: 'X25519', public: aliceEK } as any, myKeys.privateKey, 256,
  );
  const dh3 = await hardCrypto.deriveBits(
    { name: 'X25519', public: aliceEK } as any, spkPrivate, 256,
  );

  // DH4 — load + consume OPK private (one-shot)
  let dh4: ArrayBuffer | null = null;
  if (initialMessage.opkId !== undefined) {
    const opkPriv = await loadDeviceOPKPrivate(myUserId, myDeviceId, initialMessage.opkId);
    if (opkPriv) {
      dh4 = await hardCrypto.deriveBits(
        { name: 'X25519', public: aliceEK } as any, opkPriv, 256,
      );
      // Atomically delete the local private — OPK is single-use.
      await deleteDeviceOPKPrivate(myUserId, myDeviceId, initialMessage.opkId);
    } else {
      console.warn(
        `[X3DH-DEV] OPK #${initialMessage.opkId} private MISSING locally — degrading to 3-DH`,
      );
    }
  }

  const filler = new Uint8Array(32).fill(0xFF);
  const dhConcat = dh4
    ? concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3, dh4)
    : concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3);

  const sharedSecret = await x3dhKDF(dhConcat);
  console.info(`[X3DH-DEV] ✅ responded with ${dh4 ? '4' : '3'}-DH (SPK #${initialMessage.spkId})`);

  return { sharedSecret, spkKeyPair: { publicKey: spkPublic, privateKey: spkPrivate } };
}

/**
 * PQXDH extends X3DH by adding a KEM (Key Encapsulation Mechanism) step.
 * When ML-KEM-768 becomes available in Web Crypto:
 * 
 * 1. Alice fetches Bob's KEM public key alongside his prekey bundle
 * 2. (kemCT, kemSS) = KEM.Encapsulate(bobKemPK)
 * 3. SK = KDF(DH1 || DH2 || DH3 [|| DH4] || kemSS)
 * 4. kemCT is sent alongside the initial message
 * 
 * Bob decapsulates: kemSS = KEM.Decapsulate(kemCT, bobKemSK)
 * Then derives the same SK.
 * 
 * This provides post-quantum security: an attacker must break BOTH
 * X25519 AND ML-KEM-768 to compromise the shared secret.
 * 
 * Status: Structurally ready. Activate when browsers ship ML-KEM.
 */
export function isPQXDHAvailable(): boolean {
  try {
    return false;
  } catch {
    return false;
  }
}

// ─── Internal Helpers ───

async function importX25519Public(base64: string): Promise<CryptoKey> {
  return importOkpPublicKeyFromBase64(base64, 'X25519', [], true);
}

async function importEd25519Public(base64: string): Promise<CryptoKey> {
  return importOkpPublicKeyFromBase64(base64, 'Ed25519', ['verify'], true);
}

/**
 * X3DH KDF: HKDF-SHA-256 with zero salt (per Signal spec).
 * Returns 32 bytes of key material for Double Ratchet root key.
 */
async function x3dhKDF(ikm: ArrayBuffer): Promise<ArrayBuffer> {
  const hkdfKey = await hardCrypto.importKey(
    'raw', ikm, 'HKDF', false, ['deriveBits'],
  );

  // Salt: 32 zero bytes (Signal X3DH spec)
  const salt = new Uint8Array(X3DH_SALT_BYTES);
  const info = encodeString(X3DH_INFO);

  return hardCrypto.deriveBits(
    { name: 'HKDF', hash: HKDF_HASH, salt, info },
    hkdfKey,
    256, // 32 bytes
  );
}
