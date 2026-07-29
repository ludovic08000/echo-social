import { SIG_KEY_PARAMS, STORE_KEYS } from './constants';
import { hardCrypto } from './cryptoIntegrity';
import { runTx, reqToPromise } from './indexedDbTx';
import {
  base64ToBuffer,
  bufferToBase64,
  encodeString,
  exportKeyToJWK,
  importKeyFromJWK,
} from './utils';

export const LEGACY_DEVICE_IDENTITY_VERSION = 1;
export const ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION = 2;

export interface DeviceIdentityKey {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicB64: string;
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
    if (!jwk.x) throw new Error('DEVICE_IDENTITY_PUBLIC_EXPORT_FAILED');
    const value = jwk.x.replace(/-/g, '+').replace(/_/g, '/');
    return value + '='.repeat((4 - value.length % 4) % 4);
  }
}

export function canonicalDeviceIdentityPayload(args: {
  userId: string;
  deviceId: string;
  devicePublicKey: string;
  signingPublicKey: string;
  identityVersion?: number;
}): string {
  const version = args.identityVersion ?? LEGACY_DEVICE_IDENTITY_VERSION;
  return JSON.stringify({
    protocol: 'forsure-sesame-device',
    version,
    userId: args.userId,
    deviceId: args.deviceId,
    devicePublicKey: args.devicePublicKey,
    signingPublicKey: args.signingPublicKey,
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
  const job = createDeviceIdentityUnderLock(userId, deviceId, id).finally(() => {
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

  if (typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function') {
    return navigator.locks.request(`forsure:device-identity:${id}`, { mode: 'exclusive' }, create);
  }
  return create();
}

/**
 * Version 2 is signed by the account Ed25519 key. The optional legacy branch is
 * retained only for parsing/tests while v1 rows are migrated; secure routes use v2.
 */
export async function signDeviceIdentityBinding(args: {
  userId: string;
  deviceId: string;
  devicePublicKey: string;
  identity: DeviceIdentityKey;
  accountSigningPrivateKey?: CryptoKey;
  identityVersion?: number;
}): Promise<string> {
  const identityVersion = args.identityVersion ?? (
    args.accountSigningPrivateKey
      ? ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION
      : LEGACY_DEVICE_IDENTITY_VERSION
  );
  const payload = canonicalDeviceIdentityPayload({
    userId: args.userId,
    deviceId: args.deviceId,
    devicePublicKey: args.devicePublicKey,
    signingPublicKey: args.identity.publicB64,
    identityVersion,
  });
  const signer = identityVersion === ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION
    ? args.accountSigningPrivateKey
    : args.identity.privateKey;
  if (!signer) throw new Error('ACCOUNT_SIGNING_KEY_REQUIRED_FOR_DEVICE_V2');
  return bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    signer,
    encodeString(payload),
  ) as ArrayBuffer);
}

export async function verifyDeviceIdentityBinding(args: {
  userId: string;
  deviceId: string;
  devicePublicKey: string;
  signingPublicKey: string;
  signature: string;
  identityVersion?: number;
  accountSigningPublicKey?: string;
}): Promise<boolean> {
  const identityVersion = args.identityVersion ?? LEGACY_DEVICE_IDENTITY_VERSION;
  if (
    identityVersion !== LEGACY_DEVICE_IDENTITY_VERSION &&
    identityVersion !== ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION
  ) return false;
  if (
    identityVersion === ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION &&
    !args.accountSigningPublicKey
  ) return false;

  try {
    const verifierB64 = identityVersion === ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION
      ? args.accountSigningPublicKey!
      : args.signingPublicKey;
    const publicKey = await hardCrypto.importKey(
      'raw',
      base64ToBuffer(verifierB64),
      { name: 'Ed25519' } as Algorithm,
      false,
      ['verify'],
    );
    return await hardCrypto.verify(
      'Ed25519',
      publicKey,
      base64ToBuffer(args.signature),
      encodeString(canonicalDeviceIdentityPayload({ ...args, identityVersion })),
    );
  } catch {
    return false;
  }
}
