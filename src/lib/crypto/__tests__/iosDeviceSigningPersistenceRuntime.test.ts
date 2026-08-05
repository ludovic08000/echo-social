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
      const keyId = `signing-${runtime.generationCount}`;
      return {
        publicKey: {
          kind: 'public',
          keyId,
          jwk: { kty: 'OKP', crv: 'Ed25519', x: `${keyId}-public` },
          extractable: true,
        } satisfies FakeKey,
        privateKey: {
          kind: 'private',
          keyId,
          jwk: { kty: 'OKP', crv: 'Ed25519', x: `${keyId}-public`, d: `${keyId}-private` },
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
  base64ToBuffer: (value: string) => Buffer.from(value, 'base64').buffer,
  bufferToBase64: (value: ArrayBuffer) => Buffer.from(new Uint8Array(value)).toString('base64'),
  encodeString: (value: string) => new TextEncoder().encode(value),
  exportKeyToJWK: async (key: FakeKey) => key.jwk,
  importKeyFromJWK: async (jwk: JsonWebKey, _algorithm: unknown, _usages: KeyUsage[], extractable: boolean) => ({
    kind: jwk.d ? 'private' : 'public',
    keyId: String(jwk.x ?? 'imported'),
    jwk,
    extractable,
  } satisfies FakeKey),
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  exportPublicKeyBundle: vi.fn(),
  getOrCreateIdentityKeys: vi.fn(),
}));

vi.mock('@/lib/crypto/deviceKx', () => ({
  getOrCreateDeviceKxKey: vi.fn(),
}));

const userId = 'ffeb378a-e1b3-4bfb-8c31-72c94e4da14d';
const deviceId = 'dev_0123456789abcdef0123456789abcdef';
const storageId = `device-signing::${userId}::${deviceId}`;

async function loadDeviceIdentityModule() {
  return import('@/lib/crypto/deviceIdentity');
}

describe('native iOS Ed25519 device identity persistence', () => {
  beforeEach(() => {
    runtime.nativeRecords.clear();
    runtime.indexedRecords.clear();
    runtime.generationCount = 0;
    runtime.nativeReadUnavailable = false;
    vi.resetModules();
  });

  it('restores the same signing identity after IndexedDB is purged', async () => {
    let identity = await loadDeviceIdentityModule();
    const first = await identity.getOrCreateDeviceIdentity(userId, deviceId);

    expect(runtime.generationCount).toBe(1);
    expect(runtime.nativeRecords.has(storageId)).toBe(true);
    expect(runtime.indexedRecords.has(storageId)).toBe(true);

    runtime.indexedRecords.clear();
    vi.resetModules();
    identity = await loadDeviceIdentityModule();

    const restored = await identity.getOrCreateDeviceIdentity(userId, deviceId);
    expect(restored.publicB64).toBe(first.publicB64);
    expect(runtime.generationCount).toBe(1);
    expect(runtime.indexedRecords.has(storageId)).toBe(true);
  });

  it('migrates the legacy IndexedDB identity without changing its key', async () => {
    runtime.indexedRecords.set(storageId, {
      id: storageId,
      userId,
      deviceId,
      publicKeyJWK: { kty: 'OKP', crv: 'Ed25519', x: 'legacy-signing-public' },
      privateKeyJWK: { kty: 'OKP', crv: 'Ed25519', x: 'legacy-signing-public', d: 'legacy-signing-private' },
      createdAt: 1_700_000_000_000,
    });

    const identity = await loadDeviceIdentityModule();
    await identity.getOrCreateDeviceIdentity(userId, deviceId);

    expect(runtime.generationCount).toBe(0);
    expect(runtime.nativeRecords.has(storageId)).toBe(true);
  });

  it('fails closed rather than silently rotating identity when Keychain is unavailable', async () => {
    runtime.nativeReadUnavailable = true;
    const identity = await loadDeviceIdentityModule();

    await expect(identity.getOrCreateDeviceIdentity(userId, deviceId))
      .rejects.toThrow('E2EE_NATIVE_KEYCHAIN_UNAVAILABLE:get');
    expect(runtime.generationCount).toBe(0);
    expect(runtime.indexedRecords.size).toBe(0);
  });

  it('rejects a corrupt native identity even when a valid cache exists', async () => {
    runtime.nativeRecords.set(storageId, { id: 'wrong-signing-identity' });
    runtime.indexedRecords.set(storageId, {
      id: storageId,
      userId,
      deviceId,
      publicKeyJWK: { kty: 'OKP', crv: 'Ed25519', x: 'cached-signing-public' },
      privateKeyJWK: { kty: 'OKP', crv: 'Ed25519', x: 'cached-signing-public', d: 'cached-signing-private' },
      createdAt: 1_700_000_000_000,
    });

    const identity = await loadDeviceIdentityModule();
    await expect(identity.getOrCreateDeviceIdentity(userId, deviceId))
      .rejects.toThrow('E2EE_NATIVE_KEYCHAIN_CORRUPT');
    expect(runtime.generationCount).toBe(0);
  });
});
