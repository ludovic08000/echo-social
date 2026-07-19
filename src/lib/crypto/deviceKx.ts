/**
 * Per-device X25519 key exchange pair (true cryptographic isolation per device).
 *
 * `user_devices.device_public_key` is a dedicated X25519 keypair per
 * (user, device). The physical browser may log into several accounts, so the
 * local private material MUST NOT be keyed only by deviceId. Otherwise two
 * accounts sharing the same browser routing id can reuse/corrupt each other's
 * device KX material.
 *
 * Storage model:\n *   IndexedDB store `identity-keys`\n *   - scoped key: `device-kx::<userId>::<deviceId>`\n */

import { KX_KEY_PARAMS, STORE_KEYS } from './constants';
import { exportKeyToJWK, importKeyFromJWK, bufferToBase64 } from './utils';
import { hardCrypto } from './cryptoIntegrity';
import { runTx, reqToPromise } from './indexedDbTx';

export interface DeviceKxKey {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicB64: string;
}

interface StoredDeviceKx {
  id: string;
  publicKeyJWK: JsonWebKey;
  privateKeyJWK: JsonWebKey;
  createdAt: number;
  userId?: string;
  deviceId?: string;
}

function storageKey(deviceId: string, userId: string): string {
  return `device-kx::${userId}::${deviceId}`;
}

/**
 * iOS Safari fallback: WebKit sometimes throws `DataError` on
 * `exportKey('raw', publicKey)` for X25519/Ed25519 keys. JWK export is
 * always supported and `x` is the base64url raw point, so we convert it
 * to standard base64 ourselves.
 */
async function publicKeyToBase64(publicKey: CryptoKey): Promise<string> {
  try {
    const raw = await hardCrypto.exportKey('raw', publicKey);
    return bufferToBase64(raw as ArrayBuffer);
  } catch {
    const jwk = (await hardCrypto.exportKey('jwk', publicKey)) as JsonWebKey;
    const x = jwk?.x;
    if (typeof x !== 'string' || !x) throw new Error('jwk export missing x component');
    const b64 = x.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    return b64 + pad;
  }
}

function dbGet<T>(key: string): Promise<T | undefined> {
  return runTx([STORE_KEYS], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_KEYS).get(key) as IDBRequest<T | undefined>),
  );
}

function dbPut<T>(value: T): Promise<void> {
  return runTx([STORE_KEYS], 'readwrite', (tx) => {
    tx.objectStore(STORE_KEYS).put(value as unknown as IDBValidKey | object);
  });
}

function dbDelete(key: string): Promise<void> {
  return runTx([STORE_KEYS], 'readwrite', (tx) => {
    tx.objectStore(STORE_KEYS).delete(key);
  });
}

async function importStoredDeviceKx(stored: StoredDeviceKx): Promise<DeviceKxKey> {
  const [publicKey, privateKey] = await Promise.all([
    importKeyFromJWK(stored.publicKeyJWK, KX_KEY_PARAMS as any, [], true),
    importKeyFromJWK(stored.privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], false),
  ]);

  const raw = await publicKeyToBase64(publicKey);
  return { publicKey, privateKey, publicB64: raw };
}

/**
 * Load the per-account/per-device kx keypair if present. Returns null if none\n * is stored. Both IDs are mandatory, preventing cross-account key reuse.
 */
export async function loadDeviceKxKey(deviceId: string, userId: string): Promise<DeviceKxKey | null> {
  const stored = await dbGet<StoredDeviceKx>(storageKey(deviceId, userId));
  return stored ? importStoredDeviceKx(stored) : null;
}

/**
 * Generate a fresh per-account/per-device X25519 keypair, persist it, return
 * the import. Private key persisted as JWK for reload, then re-imported as
 * non-extractable at runtime.
 */
export async function generateDeviceKxKey(deviceId: string, userId: string): Promise<DeviceKxKey> {
  const pair = await hardCrypto.generateKey(KX_KEY_PARAMS as any, true, ['deriveBits']);
  const { publicKey, privateKey } = pair as CryptoKeyPair;

  const [publicKeyJWK, privateKeyJWK] = await Promise.all([
    exportKeyToJWK(publicKey),
    exportKeyToJWK(privateKey),
  ]);

  await dbPut<StoredDeviceKx>({
    id: storageKey(deviceId, userId),
    userId,
    deviceId,
    publicKeyJWK,
    privateKeyJWK,
    createdAt: Date.now(),
  });

  const safePriv = await importKeyFromJWK(privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], false);
  const raw = await publicKeyToBase64(publicKey);
  return { publicKey, privateKey: safePriv, publicB64: raw };
}

/**
 * Get the per-account/per-device kx key, generating one on first call.
 * Idempotent and safe to call on every app boot.
 */
export async function getOrCreateDeviceKxKey(deviceId: string, userId: string): Promise<DeviceKxKey> {
  const existing = await loadDeviceKxKey(deviceId, userId);
  if (existing) return existing;
  return generateDeviceKxKey(deviceId, userId);
}

/** Used when a device is unlinked / revoked. */
export async function deleteDeviceKxKey(deviceId: string, userId: string): Promise<void> {
  try {
    await dbDelete(storageKey(deviceId, userId));
  } catch {
    /* non-fatal */
  }
}
