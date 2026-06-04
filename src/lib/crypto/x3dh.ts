/**
 * X3DH — Extended Triple Diffie-Hellman Key Agreement (Signal Protocol)
 * 
 * Implements the full X3DH handshake as specified by Signal:
 * https://signal.org/docs/specifications/x3dh/
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { runTxOn, reqToPromise } from './indexedDbTx';
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

export interface X3DHPrekeyBundle {
  identityKey: string;
  signedPrekey: string;
  signedPrekeySignature: string;
  signedPrekeyId: number;
  signingKey: string;
  oneTimePrekey?: string;
  oneTimePrekeyId?: number;
}

export interface X3DHResult {
  sharedSecret: ArrayBuffer;
  ephemeralKey: string;
  usedOTPKId?: number;
  usedSPKId: number;
  kemCiphertext?: string;
}

export interface X3DHInitialMessage {
  ik: string;
  ek: string;
  spkId: number;
  opkId?: number;
  kemCt?: string;
}

export type DevicePrekeyBundleErrorCode = 'DEVICE_PREKEY_BUNDLE_UNAVAILABLE' | 'DEVICE_SPK_SIGNATURE_INVALID';

export class DevicePrekeyBundleError extends Error {
  code: DevicePrekeyBundleErrorCode;
  peerUserId: string;
  peerDeviceId: string;
  spkId?: number;

  constructor(code: DevicePrekeyBundleErrorCode, peerUserId: string, peerDeviceId: string, spkId?: number) {
    super(code);
    this.name = 'DevicePrekeyBundleError';
    this.code = code;
    this.peerUserId = peerUserId;
    this.peerDeviceId = peerDeviceId;
    this.spkId = spkId;
  }
}

export function isDevicePrekeyBundleError(value: unknown, code?: DevicePrekeyBundleErrorCode): value is DevicePrekeyBundleError {
  return value instanceof DevicePrekeyBundleError && (!code || value.code === code);
}

const X3DH_INFO = 'ForSure-X3DH-v1';
const X3DH_SALT_BYTES = 32;
const SPK_ROTATION_DAYS = 7;
const SPK_DB_NAME = 'forsure-spk';
const SPK_DB_VERSION = 2;
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
  const violatedConstraint = haystack.match(/constraint "([^"]+)"/i)?.[1]
    ?? haystack.match(/violates ([^\s]+) constraint/i)?.[1]
    ?? undefined;
  const diagnostic = {
    table,
    step,
    code: error?.code,
    message: error?.message,
    details: error?.details,
    hint: error?.hint,
    constraint_violated: violatedConstraint ?? 'unknown_from_supabase_error',
    rejected_column: rejectedColumn ?? 'unknown_from_supabase_error',
    rejected_value: rejectedColumn ? describeDBValue(rejectedColumn, payload[rejectedColumn]) : undefined,
    payload_keys: Object.keys(payload),
    payload: sanitizeDBPayload(payload),
  };
  console.error('[X3DH][DB][UPSERT_FAIL]', diagnostic);
  return diagnostic;
}

interface StoredSPK {
  id: string;
  spkId: number;
  privateKeyJWK: JsonWebKey;
  publicKeyBase64: string;
  createdAt: number;
}

async function saveSPKPrivate(userId: string, spkId: number, privateKey: CryptoKey, publicBase64: string): Promise<void> {
  const jwk = await hardCrypto.exportKey('jwk', privateKey);
  await runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => {
    tx.objectStore(SPK_STORE).put({ id: `${userId}:${spkId}`, spkId, privateKeyJWK: jwk, publicKeyBase64: publicBase64, createdAt: Date.now() } as StoredSPK);
  });
}

async function loadSPKRecord(userId: string, spkId: number): Promise<StoredSPK | null> {
  try {
    const result = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) =>
      reqToPromise<StoredSPK | undefined>(tx.objectStore(SPK_STORE).get(`${userId}:${spkId}`)),
    );
    return result ?? null;
  } catch {
    return null;
  }
}

async function getNextSPKId(userId: string): Promise<number> {
  try {
    const allKeys = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) => reqToPromise<IDBValidKey[]>(tx.objectStore(SPK_STORE).getAllKeys()));
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

async function gcExpiredSPKPrivates(userId: string, maxAgeMs = 30 * 24 * 60 * 60 * 1000): Promise<void> {
  try {
    const cutoff = Date.now() - maxAgeMs;
    const userPrefix = `${userId}:`;
    const purged = await runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => new Promise<number>((resolve, reject) => {
      const store = tx.objectStore(SPK_STORE);
      const cursorReq = store.openCursor();
      let count = 0;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) { resolve(count); return; }
        const id = String(cursor.key);
        const rec = cursor.value as StoredSPK;
        if (id.startsWith(userPrefix) && typeof rec.createdAt === 'number' && rec.createdAt < cutoff) {
          cursor.delete();
          count++;
        }
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    }));
    if (purged > 0) console.log(`[X3DH][GC] purged ${purged} expired SPK private(s) for user ${userId.slice(0, 8)}…`);
  } catch (e) {
    console.warn('[X3DH][GC] SPK GC failed (non-fatal):', e);
  }
}

export async function generateAndUploadSignedPrekey(userId: string, signingPrivateKey: CryptoKey): Promise<{ spkId: number; publicKey: string; signature: string }> {
  const spkId = await getNextSPKId(userId);
  const spkPair = await hardCrypto.generateKey(KX_KEY_PARAMS as any, true, ['deriveBits']) as CryptoKeyPair;
  const publicRaw = await exportPublicKeyRaw(spkPair.publicKey);
  const publicBase64 = bufferToBase64(publicRaw);
  const signature = await hardCrypto.sign('Ed25519' as any, signingPrivateKey, publicRaw);
  const signatureBase64 = bufferToBase64(signature);
  await saveSPKPrivate(userId, spkId, spkPair.privateKey, publicBase64);

  const payload = { user_id: userId, spk_id: spkId, public_key: publicBase64, signature: signatureBase64, is_active: true };
  validatePayloadForDB(payload, 'user_signed_prekeys');
  logDBPayloadBeforeUpsert('user_signed_prekeys', payload);

  const { error } = await supabase.from('user_signed_prekeys').upsert(payload, { onConflict: 'user_id,spk_id' });
  if (error) {
    const dbDiag = logDBUpsertError('user_signed_prekeys', 'user_signed_prekeys_upsert', error, payload);
    throw new Error(`X3DH_DB_UPSERT_FAILED table=user_signed_prekeys step=user_signed_prekeys_upsert code=${dbDiag.code ?? 'n/a'} rejected_column=${dbDiag.rejected_column} details=${dbDiag.details ?? 'n/a'} hint=${dbDiag.hint ?? 'n/a'} supabase_message=${dbDiag.message ?? 'n/a'}`);
  }

  await supabase.from('user_signed_prekeys').update({ is_last_resort: false }).eq('user_id', userId).eq('is_last_resort', true);
  await supabase.from('user_signed_prekeys').update({ is_active: false, is_last_resort: true }).eq('user_id', userId).eq('is_active', true).neq('spk_id', spkId);
  console.log(`[X3DH] ✅ Signed prekey #${spkId} generated & uploaded`);
  try {
    const { requestBackgroundBackup } = await import('@/lib/crypto/accountKeyBackup');
    requestBackgroundBackup('spk-rotated');
  } catch {}
  return { spkId, publicKey: publicBase64, signature: signatureBase64 };
}

export async function refreshSignedPrekeyIfNeeded(userId: string, signingPrivateKey: CryptoKey): Promise<void> {
  try {
    void gcExpiredSPKPrivates(userId);
    const { data } = await supabase.from('user_signed_prekeys').select('created_at, public_key, signature, spk_id').eq('user_id', userId).eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!data) { await generateAndUploadSignedPrekey(userId, signingPrivateKey); return; }
    let signatureValid = false;
    try {
      const { data: pubKeyData } = await supabase.from('user_public_keys').select('identity_key, signing_key').eq('user_id', userId).eq('is_active', true).maybeSingle();
      if (pubKeyData) {
        signatureValid = await verifySignedPrekey(pubKeyData.signing_key, data.public_key, data.signature, { source: 'refreshSignedPrekeyIfNeeded.current_user_spk', identityKeyB64: pubKeyData.identity_key, userId, spkId: data.spk_id });
      }
      if (!signatureValid) console.warn('[X3DH] SPK INVALID → regeneration required', { source: 'refreshSignedPrekeyIfNeeded', user_id: userId, spk_id: data.spk_id, valid: false });
    } catch (verifyErr) {
      console.warn('[X3DH] ⚠️ SPK signature verification error:', verifyErr);
      signatureValid = false;
    }
    if (!signatureValid) {
      // Legacy account-wide SPK has no device_id, so we just regenerate.
      // (Device-scoped SPKs handle their own quarantine in
      //  refreshDeviceSignedPrekeyIfNeeded below.)
      await generateAndUploadSignedPrekey(userId, signingPrivateKey);
      return;
    }
    const localRecord = await loadSPKRecord(userId, data.spk_id);
    if (!localRecord) { await generateAndUploadSignedPrekey(userId, signingPrivateKey); return; }
    const ageMs = Date.now() - new Date(data.created_at).getTime();
    if (ageMs > SPK_ROTATION_DAYS * 24 * 60 * 60 * 1000) await generateAndUploadSignedPrekey(userId, signingPrivateKey);
  } catch (e) {
    console.error('[X3DH] SPK refresh check failed:', e);
  }
}

function deviceSpkKey(userId: string, deviceId: string, spkId: number): string { return `${userId}::dev::${deviceId}::${spkId}`; }
function deviceOPKKey(userId: string, deviceId: string, opkId: number): string { return `${userId}::dev::${deviceId}::opk::${opkId}`; }

async function saveDeviceSPKPrivate(userId: string, deviceId: string, spkId: number, privateKey: CryptoKey, publicBase64: string): Promise<void> {
  const jwk = await hardCrypto.exportKey('jwk', privateKey);
  await runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => {
    tx.objectStore(SPK_STORE).put({ id: deviceSpkKey(userId, deviceId, spkId), spkId, privateKeyJWK: jwk, publicKeyBase64: publicBase64, createdAt: Date.now() } as StoredSPK);
  });
}

async function loadDeviceSPKRecord(userId: string, deviceId: string, spkId: number): Promise<StoredSPK | null> {
  try {
    const result = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) => reqToPromise<StoredSPK | undefined>(tx.objectStore(SPK_STORE).get(deviceSpkKey(userId, deviceId, spkId))));
    return result ?? null;
  } catch { return null; }
}

async function getNextDeviceSPKId(userId: string, deviceId: string): Promise<number> {
  try {
    const allKeys = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) => reqToPromise<IDBValidKey[]>(tx.objectStore(SPK_STORE).getAllKeys()));
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
  } catch { return 1; }
}

export async function generateAndUploadDeviceSignedPrekey(userId: string, deviceId: string, signingPrivateKey: CryptoKey): Promise<{ spkId: number; publicKey: string; signature: string }> {
  const spkId = await getNextDeviceSPKId(userId, deviceId);
  const spkPair = await hardCrypto.generateKey(KX_KEY_PARAMS as any, true, ['deriveBits']) as CryptoKeyPair;
  const publicRaw = await exportPublicKeyRaw(spkPair.publicKey);
  const publicBase64 = bufferToBase64(publicRaw);
  const signature = await hardCrypto.sign('Ed25519' as any, signingPrivateKey, publicRaw);
  const signatureBase64 = bufferToBase64(signature);
  await saveDeviceSPKPrivate(userId, deviceId, spkId, spkPair.privateKey, publicBase64);
  const payload = { user_id: userId, device_id: deviceId, spk_id: spkId, public_key: publicBase64, signature: signatureBase64, is_active: true };
  validatePayloadForDB(payload, 'device_signed_prekeys');
  logDBPayloadBeforeUpsert('device_signed_prekeys', payload);
  const { error } = await supabase.from('device_signed_prekeys').upsert(payload, { onConflict: 'user_id,device_id,spk_id' });
  if (error) {
    const dbDiag = logDBUpsertError('device_signed_prekeys', 'device_signed_prekeys_upsert', error, payload);
    throw new Error(`X3DH_DB_UPSERT_FAILED table=device_signed_prekeys step=device_signed_prekeys_upsert code=${dbDiag.code ?? 'n/a'} rejected_column=${dbDiag.rejected_column} details=${dbDiag.details ?? 'n/a'} hint=${dbDiag.hint ?? 'n/a'} supabase_message=${dbDiag.message ?? 'n/a'}`);
  }
  await supabase.from('device_signed_prekeys').update({ is_last_resort: false }).eq('user_id', userId).eq('device_id', deviceId).eq('is_last_resort', true);
  await supabase.from('device_signed_prekeys').update({ is_active: false, is_last_resort: true }).eq('user_id', userId).eq('device_id', deviceId).eq('is_active', true).neq('spk_id', spkId);
  console.log(`[X3DH-DEV] ✅ device SPK #${spkId} for ${deviceId.slice(0, 8)}… uploaded`);
  try { const { requestBackgroundBackup } = await import('@/lib/crypto/accountKeyBackup'); requestBackgroundBackup('device-spk-rotated'); } catch {}
  return { spkId, publicKey: publicBase64, signature: signatureBase64 };
}

export async function refreshDeviceSignedPrekeyIfNeeded(userId: string, deviceId: string, signingPrivateKey: CryptoKey): Promise<void> {
  try {
    const { data } = await supabase.from('device_signed_prekeys').select('created_at, expires_at, spk_id, public_key, signature').eq('user_id', userId).eq('device_id', deviceId).eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!data) { await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey); return; }
    const { data: pubKeyData, error: pubKeyErr } = await supabase.from('user_public_keys').select('identity_key, signing_key').eq('user_id', userId).eq('is_active', true).maybeSingle();
    if (pubKeyErr || !pubKeyData?.signing_key) { await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey); return; }
    const currentSignatureValid = await verifySignedPrekey(pubKeyData.signing_key, data.public_key, data.signature, { source: 'refreshDeviceSignedPrekeyIfNeeded.current_device_spk', identityKeyB64: pubKeyData.identity_key, userId, deviceId, spkId: data.spk_id });
    if (!currentSignatureValid) {
      // P2: server-side quarantine of the bad device SPK so peers stop
      // targeting it. If regeneration also fails, escalate by quarantining
      // the device itself. Both RPCs are best-effort — failure must never
      // block local regeneration.
      try {
        await (supabase as any).rpc('quarantine_own_invalid_device_spk', {
          p_device_id: deviceId,
          p_spk_id: data.spk_id,
          p_reason: 'own_device_spk_signature_invalid',
        });
      } catch (qErr) {
        console.warn('[X3DH-DEV] quarantine_own_invalid_device_spk failed (non-fatal):', qErr);
      }
      try {
        await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey);
      } catch (regenErr) {
        console.warn('[X3DH-DEV] SPK regeneration failed — quarantining device:', regenErr);
        try {
          await (supabase as any).rpc('quarantine_own_invalid_device', {
            p_device_id: deviceId,
            p_reason: 'own_device_spk_regeneration_failed',
          });
        } catch (qErr2) {
          console.warn('[X3DH-DEV] quarantine_own_invalid_device failed (non-fatal):', qErr2);
        }
      }
      return;
    }
    const local = await loadDeviceSPKRecord(userId, deviceId, data.spk_id);
    if (!local) { await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey); return; }
    const now = Date.now();
    const ageMs = now - new Date(data.created_at).getTime();
    const expiresAtMs = data.expires_at ? new Date(data.expires_at).getTime() : Infinity;
    const expiresInMs = expiresAtMs - now;
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    if (ageMs > SPK_ROTATION_DAYS * 24 * 60 * 60 * 1000 || expiresInMs < SEVEN_DAYS_MS) await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey);
  } catch (e) { console.warn('[X3DH-DEV] device SPK refresh failed (non-fatal):', e); }
}

const OPK_BATCH_SIZE = 100;
const OPK_LOW_THRESHOLD = 25;

async function saveDeviceOPKPrivate(userId: string, deviceId: string, opkId: number, privateKey: CryptoKey, publicBase64: string): Promise<void> {
  const jwk = await hardCrypto.exportKey('jwk', privateKey);
  await runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => {
    tx.objectStore(SPK_STORE).put({ id: deviceOPKKey(userId, deviceId, opkId), spkId: opkId, privateKeyJWK: jwk, publicKeyBase64: publicBase64, createdAt: Date.now() } as StoredSPK);
  });
}

async function loadDeviceOPKPrivate(userId: string, deviceId: string, opkId: number): Promise<CryptoKey | null> {
  try {
    const result = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) => reqToPromise<StoredSPK | undefined>(tx.objectStore(SPK_STORE).get(deviceOPKKey(userId, deviceId, opkId))));
    if (!result) return null;
    return importKeyFromJWK(result.privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], false);
  } catch { return null; }
}

async function deleteDeviceOPKPrivate(userId: string, deviceId: string, opkId: number): Promise<void> {
  try { await runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => { tx.objectStore(SPK_STORE).delete(deviceOPKKey(userId, deviceId, opkId)); }); } catch {}
}

async function getNextDeviceOPKBaseId(userId: string, deviceId: string): Promise<number> {
  let localMax = 0;
  try {
    const allKeys = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) => reqToPromise<IDBValidKey[]>(tx.objectStore(SPK_STORE).getAllKeys()));
    const prefix = `${userId}::dev::${deviceId}::opk::`;
    for (const key of allKeys) {
      const k = String(key);
      if (k.startsWith(prefix)) {
        const id = parseInt(k.slice(prefix.length), 10);
        if (!Number.isNaN(id) && id > localMax) localMax = id;
      }
    }
  } catch {}

  let serverMax = 0;
  try {
    const { data } = await supabase
      .from('device_one_time_prekeys')
      .select('opk_id')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .order('opk_id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data?.opk_id && Number.isFinite(data.opk_id)) serverMax = Number(data.opk_id);
  } catch {}

  return Math.max(localMax, serverMax) + 1;
}

export async function refillDeviceOneTimePrekeysIfNeeded(userId: string, deviceId: string): Promise<void> {
  try {
    const { data: count, error: countErr } = await supabase.rpc('count_device_one_time_prekeys', { p_user_id: userId, p_device_id: deviceId });
    if (countErr) { console.warn('[X3DH-OPK] count failed:', countErr.message); return; }
    const available = (count as unknown as number) ?? 0;
    if (available >= OPK_LOW_THRESHOLD) return;
    console.log(`[X3DH-OPK] pool low (${available}/${OPK_LOW_THRESHOLD}) → refilling +${OPK_BATCH_SIZE}`);
    const baseId = await getNextDeviceOPKBaseId(userId, deviceId);
    const rows: Array<{ user_id: string; device_id: string; opk_id: number; public_key: string }> = [];
    for (let i = 0; i < OPK_BATCH_SIZE; i++) {
      const opkId = baseId + i;
      const pair = await hardCrypto.generateKey(KX_KEY_PARAMS as any, true, ['deriveBits']) as CryptoKeyPair;
      const pubRaw = await exportPublicKeyRaw(pair.publicKey);
      const pubB64 = bufferToBase64(pubRaw);
      await saveDeviceOPKPrivate(userId, deviceId, opkId, pair.privateKey, pubB64);
      rows.push({ user_id: userId, device_id: deviceId, opk_id: opkId, public_key: pubB64 });
    }
    const { error: insErr } = await supabase.from('device_one_time_prekeys').upsert(rows as any, { onConflict: 'user_id,device_id,opk_id', ignoreDuplicates: true });
    if (insErr) { console.warn('[X3DH-OPK] batch upsert failed:', insErr.message); return; }
    console.log(`[X3DH-OPK] ✅ ${OPK_BATCH_SIZE} new OPKs published for ${deviceId.slice(0, 8)}…`);
    try { const { requestBackgroundBackup } = await import('@/lib/crypto/accountKeyBackup'); requestBackgroundBackup('opk-refilled'); } catch {}
  } catch (e) { console.warn('[X3DH-OPK] refill failed (non-fatal):', e); }
}

async function claimPeerDeviceOPK(peerUserId: string, peerDeviceId: string): Promise<{ opkId: number; publicKey: string } | null> {
  try {
    const { data, error } = await supabase.rpc('claim_device_one_time_prekey', { p_user_id: peerUserId, p_device_id: peerDeviceId });
    if (error || !data || (data as any[]).length === 0) return null;
    const row = (data as any[])[0];
    return { opkId: row.opk_id as number, publicKey: row.public_key as string };
  } catch { return null; }
}

async function fetchDevicePrekeyMaterial(peerUserId: string, peerDeviceId: string): Promise<{ identityKey: string; signingKey: string; spkId: number; publicKey: string; signature: string } | null> {
  const { data: pubKeys } = await supabase.from('user_public_keys').select('identity_key, signing_key').eq('user_id', peerUserId).eq('is_active', true).maybeSingle();
  if (!pubKeys) return null;
  const { data: spkRows, error } = await supabase.rpc('get_device_prekey_bundle', { p_user_id: peerUserId, p_device_id: peerDeviceId });
  if (error || !spkRows || spkRows.length === 0) return null;
  const spk = spkRows[0] as { spk_id: number; public_key: string; signature: string };
  return { identityKey: pubKeys.identity_key, signingKey: pubKeys.signing_key, spkId: spk.spk_id, publicKey: spk.public_key, signature: spk.signature };
}

function safeBase64BytesLength(value: string): number | 'invalid_base64' { try { return base64ToBuffer(value).byteLength; } catch { return 'invalid_base64'; } }

async function verifySignedPrekey(signingKeyB64: string, spkPublicB64: string, signatureB64: string, context: { source: string; identityKeyB64?: string; userId?: string; deviceId?: string; spkId?: number | string } = { source: 'unknown' }): Promise<boolean> {
  const diagBase = { source: context.source, user_id: context.userId, device_id: context.deviceId, spk_id: context.spkId, encoding: 'base64(raw Ed25519 signature over raw X25519 SPK public key)', identity_len: context.identityKeyB64?.length ?? null, signing_len: signingKeyB64?.length ?? null, spk_len: spkPublicB64?.length ?? null, sig_len: signatureB64?.length ?? null, identity_bytes: context.identityKeyB64 ? safeBase64BytesLength(context.identityKeyB64) : null, signing_bytes: signingKeyB64 ? safeBase64BytesLength(signingKeyB64) : null, spk_bytes: spkPublicB64 ? safeBase64BytesLength(spkPublicB64) : null, sig_bytes: signatureB64 ? safeBase64BytesLength(signatureB64) : null };
  try {
    const peerSigningKey = await importEd25519Public(signingKeyB64);
    const valid = await hardCrypto.verify('Ed25519' as any, peerSigningKey, base64ToBuffer(signatureB64), base64ToBuffer(spkPublicB64));
    console.log('[X3DH][SPK_VERIFY]', { ...diagBase, valid });
    return valid;
  } catch (e) { console.warn('[X3DH][SPK_VERIFY_ERROR]', { ...diagBase, valid: false, error: e }); return false; }
}

export async function peekDeviceSignedPrekey(peerUserId: string, peerDeviceId: string): Promise<{ signedPrekeyId: number } | null> {
  const material = await fetchDevicePrekeyMaterial(peerUserId, peerDeviceId);
  if (!material) return null;
  const sigValid = await verifySignedPrekey(material.signingKey, material.publicKey, material.signature, { source: 'peekDeviceSignedPrekey', identityKeyB64: material.identityKey, userId: peerUserId, deviceId: peerDeviceId, spkId: material.spkId });
  if (!sigValid) {
    console.warn('[X3DH-DEV] device SPK signature INVALID', { user_id: peerUserId, device_id: peerDeviceId, spk_id: material.spkId, valid: false });
    throw new DevicePrekeyBundleError('DEVICE_SPK_SIGNATURE_INVALID', peerUserId, peerDeviceId, material.spkId);
  }
  return { signedPrekeyId: material.spkId };
}

export async function fetchPrekeyBundleForDevice(peerUserId: string, peerDeviceId: string): Promise<X3DHPrekeyBundle | null> {
  const material = await fetchDevicePrekeyMaterial(peerUserId, peerDeviceId);
  if (!material) return null;
  const sigValid = await verifySignedPrekey(material.signingKey, material.publicKey, material.signature, { source: 'fetchPrekeyBundleForDevice', identityKeyB64: material.identityKey, userId: peerUserId, deviceId: peerDeviceId, spkId: material.spkId });
  if (!sigValid) {
    console.warn('[X3DH-DEV] device SPK signature INVALID', { user_id: peerUserId, device_id: peerDeviceId, spk_id: material.spkId, valid: false });
    throw new DevicePrekeyBundleError('DEVICE_SPK_SIGNATURE_INVALID', peerUserId, peerDeviceId, material.spkId);
  }
  const opk = await claimPeerDeviceOPK(peerUserId, peerDeviceId);
  return { identityKey: material.identityKey, signingKey: material.signingKey, signedPrekey: material.publicKey, signedPrekeySignature: material.signature, signedPrekeyId: material.spkId, oneTimePrekey: opk?.publicKey, oneTimePrekeyId: opk?.opkId };
}

export async function fetchPrekeyBundle(peerUserId: string): Promise<X3DHPrekeyBundle | null> {
  const { data: pubKeys } = await supabase.from('user_public_keys').select('identity_key, signing_key').eq('user_id', peerUserId).eq('is_active', true).maybeSingle();
  if (!pubKeys) return null;
  const { data: spkData } = await supabase.rpc('get_signed_prekey', { p_user_id: peerUserId });
  if (!spkData || spkData.length === 0) return null;
  const spk = spkData[0];
  const sigValid = await verifySignedPrekey(pubKeys.signing_key, spk.public_key, spk.signature, { source: 'fetchPrekeyBundle.legacy_user_spk', identityKeyB64: pubKeys.identity_key, userId: peerUserId, spkId: spk.spk_id });
  if (!sigValid) return null;
  return { identityKey: pubKeys.identity_key, signingKey: pubKeys.signing_key, signedPrekey: spk.public_key, signedPrekeySignature: spk.signature, signedPrekeyId: spk.spk_id };
}

export async function x3dhInitiate(myKeys: IdentityKeyPair, bundle: X3DHPrekeyBundle): Promise<X3DHResult> {
  const sigValid = await verifySignedPrekey(bundle.signingKey, bundle.signedPrekey, bundle.signedPrekeySignature, { source: 'x3dhInitiate.bundle_double_check', identityKeyB64: bundle.identityKey, spkId: bundle.signedPrekeyId });
  if (!sigValid) throw new Error(`X3DH: Signed prekey signature verification FAILED`);
  const peerIK = await importX25519Public(bundle.identityKey);
  const peerSPK = await importX25519Public(bundle.signedPrekey);
  const ephemeralPair = await hardCrypto.generateKey(KX_KEY_PARAMS as any, true, ['deriveBits']) as CryptoKeyPair;
  const ephPubRaw = await exportPublicKeyRaw(ephemeralPair.publicKey);
  const ephemeralKey = bufferToBase64(ephPubRaw);
  const dh1 = await hardCrypto.deriveBits({ name: 'X25519', public: peerSPK } as any, myKeys.privateKey, 256);
  const dh2 = await hardCrypto.deriveBits({ name: 'X25519', public: peerIK } as any, ephemeralPair.privateKey, 256);
  const dh3 = await hardCrypto.deriveBits({ name: 'X25519', public: peerSPK } as any, ephemeralPair.privateKey, 256);
  let dh4: ArrayBuffer | null = null;
  if (bundle.oneTimePrekey) {
    const peerOPK = await importX25519Public(bundle.oneTimePrekey);
    dh4 = await hardCrypto.deriveBits({ name: 'X25519', public: peerOPK } as any, ephemeralPair.privateKey, 256);
  }
  const filler = new Uint8Array(32).fill(0xFF);
  const dhConcat = dh4 ? concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3, dh4) : concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3);
  const sharedSecret = await x3dhKDF(dhConcat);
  return { sharedSecret, ephemeralKey, usedOTPKId: bundle.oneTimePrekeyId, usedSPKId: bundle.signedPrekeyId };
}

export async function x3dhRespond(myKeys: IdentityKeyPair, myUserId: string, initialMessage: X3DHInitialMessage): Promise<{ sharedSecret: ArrayBuffer; spkKeyPair: CryptoKeyPair }> {
  const { assertNotReplayedAndRecord } = await import('./x3dhReplayGuard');
  await assertNotReplayedAndRecord({ myUserId, ik: initialMessage.ik, ek: initialMessage.ek, spkId: initialMessage.spkId, opkId: initialMessage.opkId });
  const aliceIK = await importX25519Public(initialMessage.ik);
  const aliceEK = await importX25519Public(initialMessage.ek);
  const spkRecord = await loadSPKRecord(myUserId, initialMessage.spkId);
  if (!spkRecord) throw new Error(`[X3DH] SPK #${initialMessage.spkId} NOT FOUND locally`);
  const spkPrivate = await importKeyFromJWK(spkRecord.privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], true);
  const spkPublic = await importX25519Public(spkRecord.publicKeyBase64);
  const dh1 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceIK } as any, spkPrivate, 256);
  const dh2 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceEK } as any, myKeys.privateKey, 256);
  const dh3 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceEK } as any, spkPrivate, 256);
  const filler = new Uint8Array(32).fill(0xFF);
  const sharedSecret = await x3dhKDF(concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3));
  return { sharedSecret, spkKeyPair: { publicKey: spkPublic, privateKey: spkPrivate } };
}

export async function x3dhRespondForDevice(myKeys: IdentityKeyPair, myUserId: string, myDeviceId: string, initialMessage: X3DHInitialMessage): Promise<{ sharedSecret: ArrayBuffer; spkKeyPair: CryptoKeyPair }> {
  const { assertNotReplayedAndRecord } = await import('./x3dhReplayGuard');
  await assertNotReplayedAndRecord({ myUserId: `${myUserId}::${myDeviceId}`, ik: initialMessage.ik, ek: initialMessage.ek, spkId: initialMessage.spkId, opkId: initialMessage.opkId });
  const aliceIK = await importX25519Public(initialMessage.ik);
  const aliceEK = await importX25519Public(initialMessage.ek);
  const spkRecord = await loadDeviceSPKRecord(myUserId, myDeviceId, initialMessage.spkId);
  if (!spkRecord) throw new Error(`[X3DH-DEV] device SPK #${initialMessage.spkId} NOT FOUND for ${myDeviceId.slice(0, 8)}…`);
  const spkPrivate = await importKeyFromJWK(spkRecord.privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], true);
  const spkPublic = await importX25519Public(spkRecord.publicKeyBase64);
  const dh1 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceIK } as any, spkPrivate, 256);
  const dh2 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceEK } as any, myKeys.privateKey, 256);
  const dh3 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceEK } as any, spkPrivate, 256);
  let dh4: ArrayBuffer | null = null;
  if (initialMessage.opkId !== undefined) {
    const opkPriv = await loadDeviceOPKPrivate(myUserId, myDeviceId, initialMessage.opkId);
    if (!opkPriv) {
      throw new Error('X3DH_OPK_PRIVATE_MISSING');
    }
    dh4 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceEK } as any, opkPriv, 256);
    await deleteDeviceOPKPrivate(myUserId, myDeviceId, initialMessage.opkId);
  }
  const filler = new Uint8Array(32).fill(0xFF);
  const dhConcat = dh4 ? concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3, dh4) : concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3);
  const sharedSecret = await x3dhKDF(dhConcat);
  return { sharedSecret, spkKeyPair: { publicKey: spkPublic, privateKey: spkPrivate } };
}

export function isPQXDHAvailable(): boolean { return false; }

async function importX25519Public(base64: string): Promise<CryptoKey> { return importOkpPublicKeyFromBase64(base64, 'X25519', [], true); }
async function importEd25519Public(base64: string): Promise<CryptoKey> { return importOkpPublicKeyFromBase64(base64, 'Ed25519', ['verify'], true); }

async function x3dhKDF(ikm: ArrayBuffer): Promise<ArrayBuffer> {
  const hkdfKey = await hardCrypto.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const salt = new Uint8Array(X3DH_SALT_BYTES);
  const info = encodeString(X3DH_INFO);
  return hardCrypto.deriveBits({ name: 'HKDF', hash: HKDF_HASH, salt, info }, hkdfKey, 256);
}
