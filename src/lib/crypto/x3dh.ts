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
  randomBytes,
} from './utils';
import {
  KX_KEY_PARAMS, SIG_KEY_PARAMS, HKDF_HASH,
  AES_ALGO, AES_KEY_LENGTH,
} from './constants';
import { supabase } from '@/integrations/supabase/client';
import { exportPublicKeyRaw } from './keyManager';
import type { DeviceKxKey } from './deviceKx';
import { fetchVerifiedDeviceIdentity } from './canonicalDeviceRegistry';
import { isSecureStoreNative } from '@/lib/secureStore';
import { readNativeKeyRecord, removeNativeKeyRecord, writeNativeKeyRecord } from './nativeKeyVault';

export interface X3DHPrekeyBundle {
  identityKey: string;
  signedPrekey: string;
  signedPrekeySignature: string;
  signedPrekeyId: number;
  signingKey: string;
  oneTimePrekey?: string;
  oneTimePrekeyId?: number;
}

export interface FetchDevicePrekeyBundleOptions {
  /**
   * Claim and consume a server-side one-time prekey for this bootstrap.
   * Defaults to true. Callers that deliberately build an SPK-only envelope
   * must set this to false before the bundle is fetched, otherwise an OPK is
   * consumed and then discarded.
   */
  claimOneTimePrekey?: boolean;
  /** Conversation authorizing this destructive OPK claim. */
  conversationId?: string;
  /** Current authorized installation performing the claim. */
  senderDeviceId?: string;
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

export type DevicePrekeyBundleErrorCode =
  | 'DEVICE_PREKEY_BUNDLE_UNAVAILABLE'
  | 'DEVICE_PREKEY_BUNDLE_FETCH_FAILED'
  | 'DEVICE_SIGNED_PREKEY_UNAVAILABLE'
  | 'DEVICE_SPK_SIGNATURE_INVALID'
  | 'ACCOUNT_IDENTITY_BINDING_INVALID';

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

function validatePayloadForDB(payload: Record<string, unknown>, tableName: 'device_signed_prekeys'): void {
  const required = ['user_id', 'device_id', 'spk_id', 'public_key', 'signature', 'is_active'];

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

function logDBPayloadBeforeUpsert(table: 'device_signed_prekeys', payload: Record<string, unknown>) {
  console.info('[X3DH][DB][UPSERT]', { table, field_count: Object.keys(payload).length });
}

function logDBUpsertError(
  table: 'device_signed_prekeys',
  step: string,
  error: { code?: string | null; message?: string | null; details?: string | null; hint?: string | null },
  payload: Record<string, unknown>,
) {
  const haystack = [error.message, error.details, error.hint].filter(Boolean).join(' ');
  const rejectedColumn = Object.keys(payload).find((key) =>
    new RegExp(`\\b${key}\\b`, 'i').test(haystack),
  );
  const violatedConstraint = haystack.match(/constraint "([^"]+)"/i)?.[1]
    ?? haystack.match(/violates ([^\s]+) constraint/i)?.[1]
    ?? undefined;
  const diagnostic = {
    table,
    step,
    code: error?.code ?? 'DB_ERROR',
    constraint_violated: violatedConstraint ?? 'unknown',
    rejected_column: rejectedColumn ?? 'unknown',
    field_count: Object.keys(payload).length,
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

function deviceSpkKey(userId: string, deviceId: string, spkId: number): string { return `${userId}::dev::${deviceId}::${spkId}`; }
function deviceOPKKey(userId: string, deviceId: string, opkId: number): string { return `${userId}::dev::${deviceId}::opk::${opkId}`; }
function nativePrekeyKey(id: string): string { return `x3dh-prekey::${id}`; }

function isStoredPrekey(value: unknown, id: string): value is StoredSPK {
  const candidate = value as Partial<StoredSPK> | null;
  return Boolean(
    candidate &&
    candidate.id === id &&
    typeof candidate.spkId === 'number' && Number.isInteger(candidate.spkId) && candidate.spkId > 0 &&
    candidate.privateKeyJWK && typeof candidate.privateKeyJWK === 'object' &&
    typeof candidate.publicKeyBase64 === 'string' && candidate.publicKeyBase64.length >= 40 &&
    typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
  );
}

async function persistStoredPrekey(record: StoredSPK): Promise<void> {
  if (isSecureStoreNative()) {
    await writeNativeKeyRecord(nativePrekeyKey(record.id), record);
    await runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => {
      tx.objectStore(SPK_STORE).put(record);
    }).catch(() => undefined);
    return;
  }
  await runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => {
    tx.objectStore(SPK_STORE).put(record);
  });
}

async function loadStoredPrekey(id: string): Promise<StoredSPK | null> {
  if (isSecureStoreNative()) {
    const native = await readNativeKeyRecord(nativePrekeyKey(id), (value): value is StoredSPK =>
      isStoredPrekey(value, id));
    if (native) {
      await runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => {
        tx.objectStore(SPK_STORE).put(native);
      }).catch(() => undefined);
      return native;
    }
    const legacy = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) =>
      reqToPromise<StoredSPK | undefined>(tx.objectStore(SPK_STORE).get(id)),
    ).catch(() => undefined);
    if (!legacy) return null;
    if (!isStoredPrekey(legacy, id)) throw new Error('E2EE_PREKEY_RECORD_INVALID');
    await writeNativeKeyRecord(nativePrekeyKey(id), legacy);
    return legacy;
  }
  const stored = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) =>
    reqToPromise<StoredSPK | undefined>(tx.objectStore(SPK_STORE).get(id)),
  ).catch(() => undefined);
  if (!stored) return null;
  if (!isStoredPrekey(stored, id)) throw new Error('E2EE_PREKEY_RECORD_INVALID');
  return stored;
}

async function deleteStoredPrekey(id: string): Promise<void> {
  await Promise.allSettled([
    runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => {
      tx.objectStore(SPK_STORE).delete(id);
    }),
    removeNativeKeyRecord(nativePrekeyKey(id)),
  ]);
}

async function saveDeviceSPKPrivate(userId: string, deviceId: string, spkId: number, privateKey: CryptoKey, publicBase64: string): Promise<void> {
  const jwk = await hardCrypto.exportKey('jwk', privateKey);
  await persistStoredPrekey({
    id: deviceSpkKey(userId, deviceId, spkId),
    spkId,
    privateKeyJWK: jwk,
    publicKeyBase64: publicBase64,
    createdAt: Date.now(),
  });
}

async function loadDeviceSPKRecord(userId: string, deviceId: string, spkId: number): Promise<StoredSPK | null> {
  return loadStoredPrekey(deviceSpkKey(userId, deviceId, spkId));
}

async function deleteDeviceSPKPrivate(userId: string, deviceId: string, spkId: number): Promise<void> {
  await deleteStoredPrekey(deviceSpkKey(userId, deviceId, spkId));
}

function randomPositiveId(): number {
  const bytes = randomBytes(4);
  const value = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) & 0x7fffffff;
  return value === 0 ? 1 : value;
}

async function pruneOldDeviceSPKs(userId: string, deviceId: string, activeSpkId: number): Promise<void> {
  const prefix = `${userId}::dev::${deviceId}::`;
  const now = Date.now();
  const maxAgeMs = 45 * 24 * 60 * 60 * 1000;
  const records = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) =>
    reqToPromise<StoredSPK[]>(tx.objectStore(SPK_STORE).getAll()),
  ).catch(() => [] as StoredSPK[]);
  const stale = records
    .filter((record) => record.id.startsWith(prefix) && !record.id.includes('::opk::'))
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((record, index) =>
      record.spkId !== activeSpkId && (index >= 4 || now - record.createdAt > maxAgeMs));
  await Promise.all(stale.map((record) => deleteStoredPrekey(record.id)));
}

export async function generateAndUploadDeviceSignedPrekey(
  userId: string,
  deviceId: string,
  signingPrivateKey: CryptoKey,
): Promise<{ spkId: number; publicKey: string; signature: string }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const spkId = randomPositiveId();
    const spkPair = await hardCrypto.generateKey(KX_KEY_PARAMS, true, ['deriveBits']) as CryptoKeyPair;
    const publicRaw = await exportPublicKeyRaw(spkPair.publicKey);
    const publicBase64 = bufferToBase64(publicRaw);
    const signatureBase64 = bufferToBase64(await hardCrypto.sign(
      'Ed25519',
      signingPrivateKey,
      publicRaw,
    ) as ArrayBuffer);
    await saveDeviceSPKPrivate(userId, deviceId, spkId, spkPair.privateKey, publicBase64);

    const { data, error } = await (supabase as any).rpc('publish_device_signed_prekey', {
      p_device_id: deviceId,
      p_spk_id: spkId,
      p_public_key: publicBase64,
      p_signature: signatureBase64,
    });
    const result = data as { ok?: boolean; code?: string } | null;
    if (!error && result?.ok === true) {
      await pruneOldDeviceSPKs(userId, deviceId, spkId).catch(() => undefined);
      return { spkId, publicKey: publicBase64, signature: signatureBase64 };
    }

    await deleteDeviceSPKPrivate(userId, deviceId, spkId);
    const code = String(result?.code ?? error?.message ?? 'UNKNOWN');
    if (!/SPK_ID_CONFLICT/i.test(code)) {
      throw new Error(`X3DH_SPK_PUBLISH_FAILED:${code}`);
    }
  }
  throw new Error('X3DH_SPK_ID_ALLOCATION_EXHAUSTED');
}

export async function refreshDeviceSignedPrekeyIfNeeded(
  userId: string,
  deviceId: string,
  signingPrivateKey: CryptoKey,
): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('device_signed_prekeys')
      .select('created_at,expires_at,spk_id,public_key,signature')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) {
      await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey);
      return;
    }

    const { getOrCreateDeviceIdentity } = await import('./deviceIdentity');
    const localIdentity = await getOrCreateDeviceIdentity(userId, deviceId);
    const signatureValid = await verifySignedPrekey(
      localIdentity.publicB64,
      data.public_key,
      data.signature,
      { source: 'refreshDeviceSignedPrekeyIfNeeded', userId, deviceId, spkId: data.spk_id },
    );
    const local = await loadDeviceSPKRecord(userId, deviceId, data.spk_id);
    if (!signatureValid) {
      try {
        await (supabase as any).rpc('quarantine_own_invalid_device_spk', {
          p_device_id: deviceId,
          p_spk_id: data.spk_id,
          p_reason: 'own_device_spk_signature_invalid',
        });
      } catch (error) {
        console.warn('[X3DH-DEV] invalid SPK repair marker failed:', error);
      }
      await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey);
      return;
    }
    if (!local || local.publicKeyBase64 !== data.public_key) {
      await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey);
      return;
    }

    const now = Date.now();
    const ageMs = now - new Date(data.created_at).getTime();
    const expiresAtMs = data.expires_at ? new Date(data.expires_at).getTime() : Infinity;
    if (
      ageMs > SPK_ROTATION_DAYS * 24 * 60 * 60 * 1000 ||
      expiresAtMs - now < 7 * 24 * 60 * 60 * 1000
    ) {
      await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey);
    }
  } catch (error) {
    console.warn('[X3DH-DEV] device SPK refresh failed:', error);
    throw error;
  }
}

const OPK_BATCH_SIZE = 100;
const OPK_LOW_THRESHOLD = 25;

async function saveDeviceOPKPrivate(userId: string, deviceId: string, opkId: number, privateKey: CryptoKey, publicBase64: string): Promise<void> {
  const jwk = await hardCrypto.exportKey('jwk', privateKey);
  await persistStoredPrekey({
    id: deviceOPKKey(userId, deviceId, opkId),
    spkId: opkId,
    privateKeyJWK: jwk,
    publicKeyBase64: publicBase64,
    createdAt: Date.now(),
  });
}

async function loadDeviceOPKPrivate(userId: string, deviceId: string, opkId: number): Promise<CryptoKey | null> {
  const result = await loadStoredPrekey(deviceOPKKey(userId, deviceId, opkId));
  if (!result) return null;
  return importKeyFromJWK(result.privateKeyJWK, KX_KEY_PARAMS, ['deriveBits'], false);
}

async function deleteDeviceOPKPrivate(userId: string, deviceId: string, opkId: number): Promise<void> {
  await deleteStoredPrekey(deviceOPKKey(userId, deviceId, opkId));
}

export async function refillDeviceOneTimePrekeysIfNeeded(userId: string, deviceId: string): Promise<void> {
  const { data: count, error: countError } = await (supabase as any).rpc(
    'count_device_one_time_prekeys',
    { p_user_id: userId, p_device_id: deviceId },
  );
  if (countError) throw countError;
  const available = Number(count ?? 0);
  if (available >= OPK_LOW_THRESHOLD) return;

  const rows: Array<{ opk_id: number; public_key: string }> = [];
  const allocated = new Set<number>();
  while (rows.length < OPK_BATCH_SIZE) {
    const opkId = randomPositiveId();
    if (allocated.has(opkId)) continue;
    allocated.add(opkId);
    const pair = await hardCrypto.generateKey(KX_KEY_PARAMS, true, ['deriveBits']) as CryptoKeyPair;
    const publicKey = bufferToBase64(await exportPublicKeyRaw(pair.publicKey));
    await saveDeviceOPKPrivate(userId, deviceId, opkId, pair.privateKey, publicKey);
    rows.push({ opk_id: opkId, public_key: publicKey });
  }

  const { data, error } = await (supabase as any).rpc('publish_device_one_time_prekeys', {
    p_device_id: deviceId,
    p_prekeys: rows,
  });
  const result = data as { ok?: boolean; accepted_ids?: number[]; code?: string } | null;
  if (error || result?.ok !== true) {
    await Promise.all(rows.map((row) => deleteDeviceOPKPrivate(userId, deviceId, row.opk_id)));
    throw new Error(`X3DH_OPK_PUBLISH_FAILED:${result?.code ?? error?.message ?? 'UNKNOWN'}`);
  }

  const accepted = new Set((result.accepted_ids ?? []).map(Number));
  await Promise.all(rows
    .filter((row) => !accepted.has(row.opk_id))
    .map((row) => deleteDeviceOPKPrivate(userId, deviceId, row.opk_id)));
}

async function claimPeerDeviceOPK(
  peerUserId: string,
  peerDeviceId: string,
  conversationId: string,
  senderDeviceId: string,
): Promise<{ opkId: number; publicKey: string } | null> {
  try {
    const { data, error } = await supabase.rpc('claim_device_one_time_prekey', {
      p_user_id: peerUserId,
      p_device_id: peerDeviceId,
      p_conversation_id: conversationId,
      p_sender_device_id: senderDeviceId,
    });
    if (error || !data || data.length === 0) return null;
    const row = data[0];
    return { opkId: row.opk_id, publicKey: row.public_key };
  } catch { return null; }
}

async function fetchDevicePrekeyMaterial(
  peerUserId: string,
  peerDeviceId: string,
): Promise<{ identityKey: string; signingKey: string; spkId: number; publicKey: string; signature: string }> {
  const device = await fetchVerifiedDeviceIdentity(peerUserId, peerDeviceId);
  if (!device) {
    throw new DevicePrekeyBundleError(
      'ACCOUNT_IDENTITY_BINDING_INVALID',
      peerUserId,
      peerDeviceId,
    );
  }
  const { data: spkRows, error } = await (supabase as any).rpc('get_device_prekey_bundle', {
    p_user_id: peerUserId,
    p_device_id: peerDeviceId,
  });
  if (error) {
    throw new DevicePrekeyBundleError(
      'DEVICE_PREKEY_BUNDLE_FETCH_FAILED',
      peerUserId,
      peerDeviceId,
    );
  }
  if (!spkRows || spkRows.length === 0) {
    throw new DevicePrekeyBundleError(
      'DEVICE_SIGNED_PREKEY_UNAVAILABLE',
      peerUserId,
      peerDeviceId,
    );
  }
  const spk = spkRows[0] as { spk_id: number; public_key: string; signature: string };
  return {
    identityKey: device.devicePublicKey,
    signingKey: device.deviceSigningKey,
    spkId: Number(spk.spk_id),
    publicKey: spk.public_key,
    signature: spk.signature,
  };
}

function safeBase64BytesLength(value: string): number | 'invalid_base64' { try { return base64ToBuffer(value).byteLength; } catch { return 'invalid_base64'; } }

async function verifySignedPrekey(signingKeyB64: string, spkPublicB64: string, signatureB64: string, context: { source: string; identityKeyB64?: string; userId?: string; deviceId?: string; spkId?: number | string } = { source: 'unknown' }): Promise<boolean> {
  const diagBase = { source: context.source, user_id: context.userId, device_id: context.deviceId, spk_id: context.spkId, encoding: 'base64(raw Ed25519 signature over raw X25519 SPK public key)', identity_len: context.identityKeyB64?.length ?? null, signing_len: signingKeyB64?.length ?? null, spk_len: spkPublicB64?.length ?? null, sig_len: signatureB64?.length ?? null, identity_bytes: context.identityKeyB64 ? safeBase64BytesLength(context.identityKeyB64) : null, signing_bytes: signingKeyB64 ? safeBase64BytesLength(signingKeyB64) : null, spk_bytes: spkPublicB64 ? safeBase64BytesLength(spkPublicB64) : null, sig_bytes: signatureB64 ? safeBase64BytesLength(signatureB64) : null };
  try {
    const peerSigningKey = await importEd25519Public(signingKeyB64);
    const valid = await hardCrypto.verify('Ed25519', peerSigningKey, base64ToBuffer(signatureB64), base64ToBuffer(spkPublicB64));
    console.log('[X3DH][SPK_VERIFY]', { ...diagBase, valid });
    return valid;
  } catch (e) { console.warn('[X3DH][SPK_VERIFY_ERROR]', { ...diagBase, valid: false, error: e }); return false; }
}

export async function peekDeviceSignedPrekey(peerUserId: string, peerDeviceId: string): Promise<{ signedPrekeyId: number } | null> {
  const material = await fetchDevicePrekeyMaterial(peerUserId, peerDeviceId);
  const sigValid = await verifySignedPrekey(material.signingKey, material.publicKey, material.signature, { source: 'peekDeviceSignedPrekey', identityKeyB64: material.identityKey, userId: peerUserId, deviceId: peerDeviceId, spkId: material.spkId });
  if (!sigValid) {
    console.warn('[X3DH-DEV] device SPK signature INVALID', { user_id: peerUserId, device_id: peerDeviceId, spk_id: material.spkId, valid: false });
    throw new DevicePrekeyBundleError('DEVICE_SPK_SIGNATURE_INVALID', peerUserId, peerDeviceId, material.spkId);
  }
  return { signedPrekeyId: material.spkId };
}

export async function fetchPrekeyBundleForDevice(
  peerUserId: string,
  peerDeviceId: string,
  options: FetchDevicePrekeyBundleOptions = {},
): Promise<X3DHPrekeyBundle | null> {
  const material = await fetchDevicePrekeyMaterial(peerUserId, peerDeviceId);
  const sigValid = await verifySignedPrekey(material.signingKey, material.publicKey, material.signature, { source: 'fetchPrekeyBundleForDevice', identityKeyB64: material.identityKey, userId: peerUserId, deviceId: peerDeviceId, spkId: material.spkId });
  if (!sigValid) {
    console.warn('[X3DH-DEV] device SPK signature INVALID', { user_id: peerUserId, device_id: peerDeviceId, spk_id: material.spkId, valid: false });
    throw new DevicePrekeyBundleError('DEVICE_SPK_SIGNATURE_INVALID', peerUserId, peerDeviceId, material.spkId);
  }
  const shouldClaimOpk = options.claimOneTimePrekey !== false &&
    Boolean(options.conversationId) &&
    Boolean(options.senderDeviceId);
  const opk = shouldClaimOpk
    ? await claimPeerDeviceOPK(
      peerUserId,
      peerDeviceId,
      options.conversationId!,
      options.senderDeviceId!,
    )
    : null;
  return { identityKey: material.identityKey, signingKey: material.signingKey, signedPrekey: material.publicKey, signedPrekeySignature: material.signature, signedPrekeyId: material.spkId, oneTimePrekey: opk?.publicKey, oneTimePrekeyId: opk?.opkId };
}

export async function x3dhInitiate(myKeys: Pick<DeviceKxKey, 'privateKey'>, bundle: X3DHPrekeyBundle): Promise<X3DHResult> {
  const sigValid = await verifySignedPrekey(bundle.signingKey, bundle.signedPrekey, bundle.signedPrekeySignature, { source: 'x3dhInitiate.bundle_double_check', identityKeyB64: bundle.identityKey, spkId: bundle.signedPrekeyId });
  if (!sigValid) throw new Error(`X3DH: Signed prekey signature verification FAILED`);
  const peerIK = await importX25519Public(bundle.identityKey);
  const peerSPK = await importX25519Public(bundle.signedPrekey);
  const ephemeralPair = await hardCrypto.generateKey(KX_KEY_PARAMS, true, ['deriveBits']) as CryptoKeyPair;
  const ephPubRaw = await exportPublicKeyRaw(ephemeralPair.publicKey);
  const ephemeralKey = bufferToBase64(ephPubRaw);
  const dh1 = await hardCrypto.deriveBits({ name: 'X25519', public: peerSPK } as Algorithm & { public: CryptoKey }, myKeys.privateKey, 256);
  const dh2 = await hardCrypto.deriveBits({ name: 'X25519', public: peerIK } as Algorithm & { public: CryptoKey }, ephemeralPair.privateKey, 256);
  const dh3 = await hardCrypto.deriveBits({ name: 'X25519', public: peerSPK } as Algorithm & { public: CryptoKey }, ephemeralPair.privateKey, 256);
  let dh4: ArrayBuffer | null = null;
  if (bundle.oneTimePrekey) {
    const peerOPK = await importX25519Public(bundle.oneTimePrekey);
    dh4 = await hardCrypto.deriveBits({ name: 'X25519', public: peerOPK } as Algorithm & { public: CryptoKey }, ephemeralPair.privateKey, 256);
  }
  const filler = new Uint8Array(32).fill(0xFF);
  const dhConcat = dh4 ? concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3, dh4) : concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3);
  const sharedSecret = await x3dhKDF(dhConcat);
  return { sharedSecret, ephemeralKey, usedOTPKId: bundle.oneTimePrekeyId, usedSPKId: bundle.signedPrekeyId };
}

export async function x3dhRespondForDevice(myKeys: Pick<DeviceKxKey, 'privateKey'>, myUserId: string, myDeviceId: string, initialMessage: X3DHInitialMessage): Promise<{
  sharedSecret: ArrayBuffer;
  spkKeyPair: CryptoKeyPair;
  replayReservation: import('./aegisReplayGuard').AegisReplayReservation;
  usedOpkId?: number;
}> {
  const { reserveAegisInitial, cancelAegisInitial } = await import('./aegisReplayGuard');
  const replayReservation = await reserveAegisInitial({
    myUserId: `${myUserId}::${myDeviceId}`,
    ik: initialMessage.ik,
    ek: initialMessage.ek,
    spkId: initialMessage.spkId,
    opkId: initialMessage.opkId,
  });

  try {
    const aliceIK = await importX25519Public(initialMessage.ik);
    const aliceEK = await importX25519Public(initialMessage.ek);
    const spkRecord = await loadDeviceSPKRecord(myUserId, myDeviceId, initialMessage.spkId);
    if (!spkRecord) throw new Error(`[X3DH-DEV] device SPK #${initialMessage.spkId} NOT FOUND for ${myDeviceId.slice(0, 8)}…`);
    const spkPrivate = await importKeyFromJWK(
      spkRecord.privateKeyJWK,
      KX_KEY_PARAMS,
      ['deriveBits'],
      false,
    );
    const spkPublic = await importX25519Public(spkRecord.publicKeyBase64);
    const dh1 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceIK } as Algorithm & { public: CryptoKey }, spkPrivate, 256);
    const dh2 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceEK } as Algorithm & { public: CryptoKey }, myKeys.privateKey, 256);
    const dh3 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceEK } as Algorithm & { public: CryptoKey }, spkPrivate, 256);
    let dh4: ArrayBuffer | null = null;
    if (initialMessage.opkId !== undefined) {
      const opkPriv = await loadDeviceOPKPrivate(myUserId, myDeviceId, initialMessage.opkId);
      if (!opkPriv) throw new Error('X3DH_OPK_PRIVATE_MISSING');
      dh4 = await hardCrypto.deriveBits({ name: 'X25519', public: aliceEK } as Algorithm & { public: CryptoKey }, opkPriv, 256);
    }
    const filler = new Uint8Array(32).fill(0xFF);
    const dhConcat = dh4
      ? concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3, dh4)
      : concatBuffers(filler.buffer as ArrayBuffer, dh1, dh2, dh3);
    const sharedSecret = await x3dhKDF(dhConcat);
    return {
      sharedSecret,
      spkKeyPair: { publicKey: spkPublic, privateKey: spkPrivate },
      replayReservation,
      usedOpkId: initialMessage.opkId,
    };
  } catch (error) {
    await cancelAegisInitial(replayReservation).catch(() => undefined);
    throw error;
  }
}

export async function finalizeDeviceX3DHInitial(args: {
  userId: string;
  deviceId: string;
  replayReservation: import('./aegisReplayGuard').AegisReplayReservation;
  usedOpkId?: number;
}): Promise<void> {
  const { finalizeAegisInitial } = await import('./aegisReplayGuard');
  await finalizeAegisInitial(args.replayReservation);
  if (args.usedOpkId !== undefined) {
    await deleteDeviceOPKPrivate(args.userId, args.deviceId, args.usedOpkId);
  }
}

export async function cancelDeviceX3DHInitial(
  replayReservation: import('./aegisReplayGuard').AegisReplayReservation,
): Promise<void> {
  const { cancelAegisInitial } = await import('./aegisReplayGuard');
  await cancelAegisInitial(replayReservation);
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
