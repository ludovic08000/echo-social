import { Capacitor, registerPlugin } from '@capacitor/core';
import { isVerifiedNativeRuntime } from '@/lib/runtimePlatform';
import { readDeviceVaultRecord, writeDeviceVaultRecord } from './deviceVault';
import { base64ToBuffer, bufferToBase64 } from './utils';
import {
  captureLibsignalStore as captureWasmStore,
  createLibsignalBundle as createWasmBundle,
  createLibsignalStore as createWasmStore,
  decryptLibsignalMessage as decryptWasmMessage,
  encryptLibsignalMessage as encryptWasmMessage,
  establishLibsignalSession as establishWasmSession,
  restoreLibsignalStore as restoreWasmStore,
} from './aegisWasmBridge';

const EXPECTED_ABI = 1;
const LIBSIGNAL_STORE_PREFIX = 'aegis.libsignal.store:';

export type LibsignalAddress = { userId: string; deviceNumber: number };
export type LibsignalCiphertext = { messageType: number; ciphertext: Uint8Array };

type NativeCapabilities = {
  available: boolean;
  engine: string;
  platform: 'android' | 'ios';
  abiVersion: number;
  pqxdh?: boolean;
  kyber1024?: boolean;
};

type NativeLibsignalPlugin = {
  getCapabilities(): Promise<NativeCapabilities>;
  createStore(options: { registrationId: number }): Promise<{ storeB64: string }>;
  createBundle(options: {
    storeB64: string;
    deviceNumber: number;
    preKeyId: number;
    signedPreKeyId: number;
    kyberPreKeyId: number;
  }): Promise<{ storeB64: string; bundleB64: string }>;
  establishSession(options: {
    storeB64: string;
    localUserId: string;
    localDeviceNumber: number;
    remoteUserId: string;
    remoteDeviceNumber: number;
    bundleB64: string;
  }): Promise<{ storeB64: string }>;
  encrypt(options: {
    storeB64: string;
    localUserId: string;
    localDeviceNumber: number;
    remoteUserId: string;
    remoteDeviceNumber: number;
    plaintextB64: string;
  }): Promise<{ storeB64: string; messageType: number; ciphertextB64: string }>;
  decrypt(options: {
    storeB64: string;
    localUserId: string;
    localDeviceNumber: number;
    remoteUserId: string;
    remoteDeviceNumber: number;
    messageType: number;
    ciphertextB64: string;
  }): Promise<{ storeB64: string; plaintextB64: string }>;
};

const NativeLibsignal = registerPlugin<NativeLibsignalPlugin>('LibSignal');
let nativeCapabilitiesPromise: Promise<NativeCapabilities> | null = null;
const nativeStoreQueues = new Map<string, Promise<void>>();

type SealedLibsignalStore = { bytes: string };
const validStore = (value: unknown): value is SealedLibsignalStore =>
  typeof value === 'object' && value !== null
  && typeof (value as SealedLibsignalStore).bytes === 'string'
  && (value as SealedLibsignalStore).bytes.length > 0;

function toBase64(bytes: Uint8Array): string {
  return bufferToBase64(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

function fromBase64(value: string, code: string): Uint8Array {
  if (!value) throw new Error(code);
  try {
    return new Uint8Array(base64ToBuffer(value));
  } catch {
    throw new Error(code);
  }
}

function vaultId(userId: string, deviceId: string): string {
  return `${LIBSIGNAL_STORE_PREFIX}${userId}:${deviceId}`;
}

function nativePlatform(): 'android' | 'ios' | null {
  if (!isVerifiedNativeRuntime()) return null;
  const platform = Capacitor.getPlatform();
  return platform === 'android' || platform === 'ios' ? platform : null;
}

async function requireNativeCapabilities(): Promise<NativeCapabilities> {
  const platform = nativePlatform();
  if (!platform) throw new Error('AEGIS_LIBSIGNAL_NATIVE_RUNTIME_REQUIRED');
  nativeCapabilitiesPromise ??= NativeLibsignal.getCapabilities().then((capabilities) => {
    if (!capabilities?.available) throw new Error('AEGIS_LIBSIGNAL_NATIVE_UNAVAILABLE');
    if (capabilities.platform !== platform) throw new Error('AEGIS_LIBSIGNAL_NATIVE_PLATFORM_MISMATCH');
    if (capabilities.abiVersion !== EXPECTED_ABI) throw new Error('AEGIS_LIBSIGNAL_NATIVE_ABI_MISMATCH');
    return capabilities;
  }).catch((error) => {
    nativeCapabilitiesPromise = null;
    throw error;
  });
  return nativeCapabilitiesPromise;
}

async function withNativeStoreLock<T>(userId: string, deviceId: string, work: () => Promise<T>): Promise<T> {
  const key = vaultId(userId, deviceId);
  const previous = nativeStoreQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  nativeStoreQueues.set(key, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (nativeStoreQueues.get(key) === queued) nativeStoreQueues.delete(key);
  }
}

async function loadNativeStore(userId: string, deviceId: string): Promise<string> {
  const record = await readDeviceVaultRecord(vaultId(userId, deviceId), validStore);
  if (!record) throw new Error('AEGIS_LIBSIGNAL_STORE_MISSING');
  return record.bytes;
}

async function commitNativeStore(userId: string, deviceId: string, bytes: string): Promise<void> {
  if (!bytes) throw new Error('AEGIS_LIBSIGNAL_STORE_INVALID');
  const id = vaultId(userId, deviceId);
  const record = { bytes } satisfies SealedLibsignalStore;
  await writeDeviceVaultRecord(id, record);
  const readback = await readDeviceVaultRecord(id, validStore);
  if (!readback || readback.bytes !== bytes) throw new Error('AEGIS_LIBSIGNAL_STORE_COMMIT_FAILED');
}

export function usesNativeLibsignal(): boolean {
  return nativePlatform() !== null;
}

export async function getLibsignalBackendInfo(): Promise<{
  kind: 'native' | 'wasm';
  platform: string;
  engine: string;
  abiVersion: number;
}> {
  const platform = nativePlatform();
  if (platform) {
    const capabilities = await requireNativeCapabilities();
    return {
      kind: 'native',
      platform,
      engine: capabilities.engine,
      abiVersion: capabilities.abiVersion,
    };
  }
  return {
    kind: 'wasm',
    platform: typeof navigator !== 'undefined' ? navigator.platform || 'web' : 'web',
    engine: 'signalapp/libsignal-rust-wasm',
    abiVersion: EXPECTED_ABI,
  };
}

export async function createLibsignalStore(args: {
  userId: string;
  deviceId: string;
  registrationId: number;
}): Promise<void> {
  if (!nativePlatform()) return createWasmStore(args);
  await requireNativeCapabilities();
  await withNativeStoreLock(args.userId, args.deviceId, async () => {
    const existing = await readDeviceVaultRecord(vaultId(args.userId, args.deviceId), validStore);
    if (existing) return;
    const result = await NativeLibsignal.createStore({ registrationId: args.registrationId });
    await commitNativeStore(args.userId, args.deviceId, result.storeB64);
  });
}

export async function createLibsignalBundle(args: {
  userId: string;
  deviceId: string;
  deviceNumber: number;
  preKeyId: number;
  signedPreKeyId: number;
  kyberPreKeyId: number;
}): Promise<Uint8Array> {
  if (!nativePlatform()) return createWasmBundle(args);
  await requireNativeCapabilities();
  return withNativeStoreLock(args.userId, args.deviceId, async () => {
    const storeB64 = await loadNativeStore(args.userId, args.deviceId);
    const result = await NativeLibsignal.createBundle({
      storeB64,
      deviceNumber: args.deviceNumber,
      preKeyId: args.preKeyId,
      signedPreKeyId: args.signedPreKeyId,
      kyberPreKeyId: args.kyberPreKeyId,
    });
    const bundle = fromBase64(result.bundleB64, 'AEGIS_LIBSIGNAL_BUNDLE_INVALID');
    await commitNativeStore(args.userId, args.deviceId, result.storeB64);
    return bundle;
  });
}

export async function establishLibsignalSession(args: {
  ownerUserId: string;
  ownerDeviceId: string;
  local: LibsignalAddress;
  remote: LibsignalAddress;
  bundle: Uint8Array;
}): Promise<void> {
  if (!nativePlatform()) return establishWasmSession(args);
  await requireNativeCapabilities();
  await withNativeStoreLock(args.ownerUserId, args.ownerDeviceId, async () => {
    const storeB64 = await loadNativeStore(args.ownerUserId, args.ownerDeviceId);
    const result = await NativeLibsignal.establishSession({
      storeB64,
      localUserId: args.local.userId,
      localDeviceNumber: args.local.deviceNumber,
      remoteUserId: args.remote.userId,
      remoteDeviceNumber: args.remote.deviceNumber,
      bundleB64: toBase64(args.bundle),
    });
    await commitNativeStore(args.ownerUserId, args.ownerDeviceId, result.storeB64);
  });
}

export async function encryptLibsignalMessage(args: {
  ownerUserId: string;
  ownerDeviceId: string;
  local: LibsignalAddress;
  remote: LibsignalAddress;
  plaintext: Uint8Array;
}): Promise<LibsignalCiphertext> {
  if (!nativePlatform()) return encryptWasmMessage(args);
  await requireNativeCapabilities();
  return withNativeStoreLock(args.ownerUserId, args.ownerDeviceId, async () => {
    const storeB64 = await loadNativeStore(args.ownerUserId, args.ownerDeviceId);
    const result = await NativeLibsignal.encrypt({
      storeB64,
      localUserId: args.local.userId,
      localDeviceNumber: args.local.deviceNumber,
      remoteUserId: args.remote.userId,
      remoteDeviceNumber: args.remote.deviceNumber,
      plaintextB64: toBase64(args.plaintext),
    });
    if (!Number.isInteger(result.messageType) || result.messageType < 0 || result.messageType > 255) {
      throw new Error('AEGIS_LIBSIGNAL_MESSAGE_TYPE_INVALID');
    }
    const ciphertext = fromBase64(result.ciphertextB64, 'AEGIS_LIBSIGNAL_CIPHERTEXT_INVALID');
    // Ratchet state must be durable before ciphertext may be returned to the network layer.
    await commitNativeStore(args.ownerUserId, args.ownerDeviceId, result.storeB64);
    return { messageType: result.messageType, ciphertext };
  });
}

export async function decryptLibsignalMessage(args: {
  ownerUserId: string;
  ownerDeviceId: string;
  local: LibsignalAddress;
  remote: LibsignalAddress;
  encrypted: LibsignalCiphertext;
}): Promise<Uint8Array> {
  if (!nativePlatform()) return decryptWasmMessage(args);
  await requireNativeCapabilities();
  return withNativeStoreLock(args.ownerUserId, args.ownerDeviceId, async () => {
    const storeB64 = await loadNativeStore(args.ownerUserId, args.ownerDeviceId);
    const result = await NativeLibsignal.decrypt({
      storeB64,
      localUserId: args.local.userId,
      localDeviceNumber: args.local.deviceNumber,
      remoteUserId: args.remote.userId,
      remoteDeviceNumber: args.remote.deviceNumber,
      messageType: args.encrypted.messageType,
      ciphertextB64: toBase64(args.encrypted.ciphertext),
    });
    const plaintext = fromBase64(result.plaintextB64, 'AEGIS_LIBSIGNAL_PLAINTEXT_INVALID');
    // Never release plaintext unless the receive-ratchet mutation was sealed first.
    await commitNativeStore(args.ownerUserId, args.ownerDeviceId, result.storeB64);
    return plaintext;
  });
}

export async function captureLibsignalStore(userId: string, deviceId: string): Promise<string> {
  if (!nativePlatform()) return captureWasmStore(userId, deviceId);
  return withNativeStoreLock(userId, deviceId, () => loadNativeStore(userId, deviceId));
}

export async function restoreLibsignalStore(userId: string, deviceId: string, bytes: string): Promise<void> {
  if (!nativePlatform()) return restoreWasmStore(userId, deviceId, bytes);
  await withNativeStoreLock(userId, deviceId, () => commitNativeStore(userId, deviceId, bytes));
}
