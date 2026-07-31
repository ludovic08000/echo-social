import { SIG_KEY_PARAMS, STORE_KEYS } from './constants';
import { hardCrypto } from './cryptoIntegrity';
import { runTx, reqToPromise } from './indexedDbTx';
import { runCrossTabExclusive } from './crossTabLock';
import {
  base64ToBuffer,
  bufferToBase64,
  encodeString,
  exportKeyToJWK,
  importKeyFromJWK,
} from './utils';
import {
  exportPublicKeyBundle,
  getOrCreateIdentityKeys,
  type PublicIdentityBundle,
} from './keyManager';
import { getOrCreateDeviceKxKey, type DeviceKxKey } from './deviceKx';

export interface DeviceIdentityKey {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicB64: string;
}

export interface PreparedDeviceAuthorization {
  account: PublicIdentityBundle;
  deviceKx: DeviceKxKey;
  deviceSigning: DeviceIdentityKey;
  authorizationSignature: string;
}

interface StoredDeviceIdentity {
  id: string;
  userId: string;
  deviceId: string;
  publicKeyJWK: JsonWebKey;
  privateKeyJWK: JsonWebKey;
  createdAt: number;
}

const creationJobs = new Map<string, Promise<DeviceIdentityKey>>();

function storageKey(userId: string, deviceId: string): string {
  return `device-signing::${userId}::${deviceId}`;
}

function dbGet<T>(key: string): Promise<T | undefined> {
  return runTx([STORE_KEYS], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(STORE_KEYS).get(key) as IDBRequest<T | undefined>),
  );
}

function dbPut<T>(value: T): Promise<void> {
  return runTx([STORE_KEYS], 'readwrite', (tx) => {
    tx.objectStore(STORE_KEYS).put(value as unknown as object);
  });
}

async function publicKeyToBase64(publicKey: CryptoKey): Promise<string> {
  try {
    return bufferToBase64(await hardCrypto.exportKey('raw', publicKey) as ArrayBuffer);
  } catch {
    const jwk = await hardCrypto.exportKey('jwk', publicKey) as JsonWebKey;
    if (!jwk.x) throw new Error('DEVICE_SIGNING_PUBLIC_EXPORT_FAILED');
    const value = jwk.x.replace(/-/g, '+').replace(/_/g, '/');
    return value + '='.repeat((4 - value.length % 4) % 4);
  }
}

/**
 * One canonical authorization statement. The stable account Ed25519 key is
 * the authority; a device never authorizes itself.
 */
export function canonicalDeviceAuthorizationPayload(args: {
  userId: string;
  deviceId: string;
  accountFingerprint: string;
  devicePublicKey: string;
  deviceSigningKey: string;
}): string {
  return JSON.stringify({
    protocol: 'forsure-aegis-device-authorization',
    userId: args.userId,
    deviceId: args.deviceId,
    accountFingerprint: args.accountFingerprint,
    devicePublicKey: args.devicePublicKey,
    deviceSigningKey: args.deviceSigningKey,
  });
}

export async function loadDeviceIdentity(
  userId: string,
  deviceId: string,
): Promise<DeviceIdentityKey | null> {
  const stored = await dbGet<StoredDeviceIdentity>(storageKey(userId, deviceId));
  if (!stored) return null;
  const [publicKey, privateKey] = await Promise.all([
    importKeyFromJWK(stored.publicKeyJWK, SIG_KEY_PARAMS, ['verify'], true),
    importKeyFromJWK(stored.privateKeyJWK, SIG_KEY_PARAMS, ['sign'], false),
  ]);
  return { publicKey, privateKey, publicB64: await publicKeyToBase64(publicKey) };
}

export async function getOrCreateDeviceIdentity(
  userId: string,
  deviceId: string,
): Promise<DeviceIdentityKey> {
  const id = storageKey(userId, deviceId);
  const pending = creationJobs.get(id);
  if (pending) return pending;

  const job = createDeviceIdentityUnderLock(userId, deviceId, id)
    .finally(() => {
      if (creationJobs.get(id) === job) creationJobs.delete(id);
    });
  creationJobs.set(id, job);
  return job;
}

async function createDeviceIdentityUnderLock(
  userId: string,
  deviceId: string,
  id: string,
): Promise<DeviceIdentityKey> {
  const create = async (): Promise<DeviceIdentityKey> => {
    const existing = await loadDeviceIdentity(userId, deviceId);
    if (existing) return existing;

    const generated = await hardCrypto.generateKey(
      SIG_KEY_PARAMS,
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const [publicKeyJWK, privateKeyJWK, publicB64] = await Promise.all([
      exportKeyToJWK(generated.publicKey),
      exportKeyToJWK(generated.privateKey),
      publicKeyToBase64(generated.publicKey),
    ]);
    await dbPut<StoredDeviceIdentity>({
      id,
      userId,
      deviceId,
      publicKeyJWK,
      privateKeyJWK,
      createdAt: Date.now(),
    });
    const privateKey = await importKeyFromJWK(
      privateKeyJWK,
      SIG_KEY_PARAMS,
      ['sign'],
      false,
    );
    return { publicKey: generated.publicKey, privateKey, publicB64 };
  };

  return runCrossTabExclusive(
    `forsure:device-identity:${id}`,
    create,
    { waitTimeoutMs: 12_000, leaseMs: 60_000 },
  );
}

export async function signDeviceAuthorization(args: {
  userId: string;
  deviceId: string;
  accountFingerprint: string;
  devicePublicKey: string;
  deviceSigningKey: string;
  accountSigningPrivateKey: CryptoKey;
}): Promise<string> {
  return bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    args.accountSigningPrivateKey,
    encodeString(canonicalDeviceAuthorizationPayload(args)),
  ) as ArrayBuffer);
}

export async function verifyDeviceAuthorization(args: {
  userId: string;
  deviceId: string;
  accountFingerprint: string;
  accountSigningKey: string;
  devicePublicKey: string;
  deviceSigningKey: string;
  authorizationSignature: string;
}): Promise<boolean> {
  try {
    const publicKey = await hardCrypto.importKey(
      'raw',
      base64ToBuffer(args.accountSigningKey),
      { name: 'Ed25519' } as Algorithm,
      false,
      ['verify'],
    );
    return await hardCrypto.verify(
      'Ed25519',
      publicKey,
      base64ToBuffer(args.authorizationSignature),
      encodeString(canonicalDeviceAuthorizationPayload(args)),
    );
  } catch {
    return false;
  }
}

export async function prepareDeviceAuthorization(
  userId: string,
  deviceId: string,
  existingDeviceKx?: DeviceKxKey | null,
): Promise<PreparedDeviceAuthorization> {
  const accountKeys = await getOrCreateIdentityKeys(userId);
  const [account, deviceKx, deviceSigning] = await Promise.all([
    exportPublicKeyBundle(accountKeys),
    existingDeviceKx ? Promise.resolve(existingDeviceKx) : getOrCreateDeviceKxKey(deviceId, userId),
    getOrCreateDeviceIdentity(userId, deviceId),
  ]);
  const authorizationSignature = await signDeviceAuthorization({
    userId,
    deviceId,
    accountFingerprint: account.fingerprint,
    devicePublicKey: deviceKx.publicB64,
    deviceSigningKey: deviceSigning.publicB64,
    accountSigningPrivateKey: accountKeys.signingPrivateKey,
  });
  return { account, deviceKx, deviceSigning, authorizationSignature };
}

// Old self-authorization names are intentionally not exported. There is one
// authority model: the stable account identity authorizes every device.
