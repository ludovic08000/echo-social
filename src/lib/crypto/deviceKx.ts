/**
 * Per-device X25519 key exchange pair (true cryptographic isolation per device).
 *
 * Until now, `user_devices.device_public_key` was published as the user's
 * SHARED identityKey, meaning the `deviceWrap` fallback derived ECDH from a
 * key common to every device of the same user. This module fixes that by
 * generating a *dedicated* X25519 keypair per device, stored locally in
 * IndexedDB and never leaving the browser.
 *
 * Storage model — strictly additive:
 *   IndexedDB store `identity-keys` (existing), key = `device-kx::<deviceId>`
 *
 * Behaviour:
 *   - generateOrLoadDeviceKxKey(deviceId) returns { publicKey, privateKey, publicB64 }.
 *   - Public key is exportable raw → base64 for upsert into `user_devices.device_public_key`.
 *   - Private key is re-imported as NON-EXTRACTABLE at runtime.
 *   - Fully backwards compatible: if generation fails, the caller falls back to
 *     publishing the shared identityKey (legacy behaviour).
 */

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
  id: string;            // 'device-kx::<deviceId>'
  publicKeyJWK: JsonWebKey;
  privateKeyJWK: JsonWebKey;
  createdAt: number;
}

function storageKey(deviceId: string): string {
  return `device-kx::${deviceId}`;
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

/**
 * Load the per-device kx keypair if present. Returns null if none stored yet.
 * Private key is loaded as non-extractable.
 */
export async function loadDeviceKxKey(deviceId: string): Promise<DeviceKxKey | null> {
  const stored = await dbGet<StoredDeviceKx>(storageKey(deviceId));
  if (!stored) return null;

  const [publicKey, privateKey] = await Promise.all([
    importKeyFromJWK(stored.publicKeyJWK, KX_KEY_PARAMS as any, [], true),
    importKeyFromJWK(stored.privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], false),
  ]);

  const raw = await publicKeyToBase64(publicKey);
  return { publicKey, privateKey, publicB64: raw };
}

/**
 * Generate a fresh per-device X25519 keypair, persist it, return the import.
 * Private key persisted as JWK (needed for re-import on page reload), but
 * always re-imported as non-extractable at runtime.
 */
export async function generateDeviceKxKey(deviceId: string): Promise<DeviceKxKey> {
  const pair = await hardCrypto.generateKey(KX_KEY_PARAMS as any, true, ['deriveBits']);
  const { publicKey, privateKey } = pair as CryptoKeyPair;

  const [publicKeyJWK, privateKeyJWK] = await Promise.all([
    exportKeyToJWK(publicKey),
    exportKeyToJWK(privateKey),
  ]);

  await dbPut<StoredDeviceKx>({
    id: storageKey(deviceId),
    publicKeyJWK,
    privateKeyJWK,
    createdAt: Date.now(),
  });

  // Re-import private as non-extractable for runtime use
  const safePriv = await importKeyFromJWK(privateKeyJWK, KX_KEY_PARAMS as any, ['deriveBits'], false);
  const raw = await publicKeyToBase64(publicKey);
  return { publicKey, privateKey: safePriv, publicB64: raw };
}

/**
 * Get the per-device kx key, generating one on first call.
 * Idempotent and safe to call on every app boot.
 */
export async function getOrCreateDeviceKxKey(deviceId: string): Promise<DeviceKxKey> {
  const existing = await loadDeviceKxKey(deviceId);
  if (existing) return existing;
  return generateDeviceKxKey(deviceId);
}

/** Used when a device is unlinked / revoked. */
export async function deleteDeviceKxKey(deviceId: string): Promise<void> {
  try {
    await dbDelete(storageKey(deviceId));
  } catch {
    /* non-fatal */
  }
}
