import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeKey {
  kind: 'public' | 'private';
  keyId: string;
  jwk: JsonWebKey;
  extractable: boolean;
}

const runtime = vi.hoisted(() => ({
  nativeRecords: new Map<string, unknown>(),
  indexedRecords: new Map<string, unknown>(),
  generationCount: 0,
  nativeReadUnavailable: false,
}));

function fakeRequest(result: unknown) {
  return { result };
}

vi.mock('@/lib/secureStore', () => ({
  isSecureStoreNative: () => true,
}));

vi.mock('@/lib/crypto/nativeKeyVault', () => ({
  readNativeKeyRecord: async <T>(storageId: string, validate: (value: unknown) => value is T) => {
    if (runtime.nativeReadUnavailable) throw new Error('E2EE_NATIVE_KEYCHAIN_UNAVAILABLE:get');
    if (!runtime.nativeRecords.has(storageId)) return null;
    const value = runtime.nativeRecords.get(storageId);
    if (!validate(value)) throw new Error(`E2EE_NATIVE_KEYCHAIN_CORRUPT:${storageId}`);
    return value as T;
  },
  writeNativeKeyRecord: async (storageId: string, payload: unknown) => {
    runtime.nativeRecords.set(storageId, payload);
  },
  removeNativeKeyRecord: async (storageId: string) => {
    runtime.nativeRecords.delete(storageId);
  },
}));

vi.mock('@/lib/crypto/indexedDbTx', () => ({
  runTx: async (_stores: string[], _mode: string, fn: (tx: IDBTransaction) => unknown) => {
    const tx = {
      objectStore: () => ({
        get: (key: IDBValidKey) => fakeRequest(runtime.indexedRecords.get(String(key))),
        put: (value: { id: string }) => {
          runtime.indexedRecords.set(value.id, value);
          return fakeRequest(value.id);
        },
        delete: (key: IDBValidKey) => {
          runtime.indexedRecords.delete(String(key));
          return fakeRequest(undefined);
        },
      }),
    } as unknown as IDBTransaction;
    return Promise.resolve(fn(tx));
  },
  reqToPromise: async <T>(request: { result: T }) => request.result,
}));

vi.mock('@/lib/crypto/crossTabLock', () => ({
  runCrossTabExclusive: async (_name: string, fn: () => unknown) => fn(),
}));

vi.mock('@/lib/crypto/cryptoIntegrity', () => ({
  hardCrypto: {
    generateKey: async () => {
      runtime.generationCount += 1;
      const keyId = `kx-${runtime.generationCount}`;
      return {
        publicKey: {
          kind: 'public',
          keyId,
          jwk: { kty: 'OKP', crv: 'X25519', x: `${keyId}-public` },
          extractable: true,
        } satisfies FakeKey,
        privateKey: {
          kind: 'private',
          keyId,
          jwk: { kty: 'OKP', crv: 'X25519', x: `${keyId}-public`, d: `${keyId}-private` },
          extractable: true,
        } satisfies FakeKey,
      };
    },
    exportKey: async (format: string, key: FakeKey) => {
      if (format === 'jwk') return key.jwk;
      return new TextEncoder().encode(String(key.jwk.x ?? key.keyId)).buffer;
    },
  },
}));

vi.mock('@/lib/crypto/utils', () => ({
  exportKeyToJWK: async (key: FakeKey) => key.jwk,
  importKeyFromJWK: async (jwk: JsonWebKey, _algorithm: unknown, _usages: KeyUsage[], extractable: boolean) => ({
    kind: jwk.d ? 'private' : 'public',
    keyId: String(jwk.x ?? 'imported'),
    jwk,
    extractable,
  } satisfies FakeKey),
  bufferToBase64: (value: ArrayBuffer) => Buffer.from(new Uint8Array(value)).toString('base64'),
}));

const userId = 'ffeb378a-e1b3-4bfb-8c31-72c94e4da14d';
const deviceId = 'dev_0123456789abcdef0123456789abcdef';
const storageId = `device-kx::${userId}::${deviceId}`;

async function loadDeviceKxModule() {
  return import('@/lib/crypto/deviceKx');
}

describe('native iOS device X25519 persistence', () => {
  beforeEach(() => {
    runtime.nativeRecords.clear();
    runtime.indexedRecords.clear();
    runtime.generationCount = 0;
    runtime.nativeReadUnavailable = false;
    vi.resetModules();
  });

  it('restores the same key after an IndexedDB purge and app-module reload', async () => {
    let deviceKx = await loadDeviceKxModule();
    const first = await deviceKx.getOrCreateDeviceKxKey(deviceId, userId);

    expect(runtime.generationCount).toBe(1);
    expect(runtime.nativeRecords.has(storageId)).toBe(true);
    expect(runtime.indexedRecords.has(storageId)).toBe(true);

    runtime.indexedRecords.clear();
    vi.resetModules();
    deviceKx = await loadDeviceKxModule();

    const restored = await deviceKx.getOrCreateDeviceKxKey(deviceId, userId);
    expect(restored.publicB64).toBe(first.publicB64);
    expect(runtime.generationCount).toBe(1);
    expect(runtime.indexedRecords.has(storageId)).toBe(true);
  });

  it('migrates a valid legacy IndexedDB key to the native vault without rotation', async () => {
    runtime.indexedRecords.set(storageId, {
      id: storageId,
      userId,
      deviceId,
      publicKeyJWK: { kty: 'OKP', crv: 'X25519', x: 'legacy-public-key' },
      privateKeyJWK: { kty: 'OKP', crv: 'X25519', x: 'legacy-public-key', d: 'legacy-private-key' },
      createdAt: 1_700_000_000_000,
    });

    const deviceKx = await loadDeviceKxModule();
    await deviceKx.getOrCreateDeviceKxKey(deviceId, userId);

    expect(runtime.generationCount).toBe(0);
    expect(runtime.nativeRecords.has(storageId)).toBe(true);
  });

  it('fails closed instead of generating a replacement when Keychain reads fail', async () => {
    runtime.nativeReadUnavailable = true;
    const deviceKx = await loadDeviceKxModule();

    await expect(deviceKx.getOrCreateDeviceKxKey(deviceId, userId))
      .rejects.toThrow('E2EE_NATIVE_KEYCHAIN_UNAVAILABLE:get');
    expect(runtime.generationCount).toBe(0);
    expect(runtime.indexedRecords.size).toBe(0);
  });

  it('does not fall back to a cache when the native record is corrupt', async () => {
    runtime.nativeRecords.set(storageId, { id: 'wrong-device-key' });
    runtime.indexedRecords.set(storageId, {
      id: storageId,
      userId,
      deviceId,
      publicKeyJWK: { kty: 'OKP', crv: 'X25519', x: 'cached-public-key' },
      privateKeyJWK: { kty: 'OKP', crv: 'X25519', x: 'cached-public-key', d: 'cached-private-key' },
      createdAt: 1_700_000_000_000,
    });

    const deviceKx = await loadDeviceKxModule();
    await expect(deviceKx.getOrCreateDeviceKxKey(deviceId, userId))
      .rejects.toThrow('E2EE_NATIVE_KEYCHAIN_CORRUPT');
    expect(runtime.generationCount).toBe(0);
  });
});
