import { beforeEach, describe, expect, it, vi } from 'vitest';

const iosState = vi.hoisted(() => {
  const keychain = new Map<string, string>();
  const preferences = new Map<string, string>();
  const genericSecureStore = new Map<string, string>();

  return {
    keychain,
    preferences,
    genericSecureStore,
    bridgeUnavailable: false,
    corruptReadback: false,
    stickyDelete: false,
    genericCalls: { get: 0, set: 0, remove: 0 },
    bridge: {
      async get({ key }: { key: string }): Promise<{ value: string | null }> {
        if (iosState.bridgeUnavailable) throw new Error('native bridge unavailable');
        const value = keychain.get(key) ?? null;
        return {
          value: iosState.corruptReadback && value !== null ? `${value}:corrupt` : value,
        };
      },
      async set({ key, value }: { key: string; value: string }): Promise<void> {
        if (iosState.bridgeUnavailable) throw new Error('native bridge unavailable');
        keychain.set(key, value);
      },
      async remove({ key }: { key: string }): Promise<void> {
        if (iosState.bridgeUnavailable) throw new Error('native bridge unavailable');
        if (!iosState.stickyDelete) keychain.delete(key);
      },
    },
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
  },
  registerPlugin: (name: string) => {
    if (name !== 'AegisKeychain') throw new Error(`unexpected plugin: ${name}`);
    return iosState.bridge;
  },
}));

vi.mock('capacitor-secure-storage-plugin', () => ({
  SecureStoragePlugin: {
    async get({ key }: { key: string }) {
      iosState.genericCalls.get += 1;
      return { value: iosState.genericSecureStore.get(key) ?? null };
    },
    async set({ key, value }: { key: string; value: string }) {
      iosState.genericCalls.set += 1;
      iosState.genericSecureStore.set(key, value);
    },
    async remove({ key }: { key: string }) {
      iosState.genericCalls.remove += 1;
      iosState.genericSecureStore.delete(key);
    },
  },
}));

vi.mock('@/lib/nativeStore', () => ({
  nativeGet: async (key: string) => iosState.preferences.get(key) ?? null,
  nativeGetSync: (key: string) => iosState.preferences.get(key) ?? null,
  nativeSet: async (key: string, value: string) => {
    iosState.preferences.set(key, value);
  },
  nativeRemove: async (key: string) => {
    iosState.preferences.delete(key);
  },
}));

async function loadSecureStore() {
  return import('@/lib/secureStore');
}

describe('native iOS secure-store runtime constraints', () => {
  beforeEach(() => {
    iosState.keychain.clear();
    iosState.preferences.clear();
    iosState.genericSecureStore.clear();
    iosState.bridgeUnavailable = false;
    iosState.corruptReadback = false;
    iosState.stickyDelete = false;
    iosState.genericCalls.get = 0;
    iosState.genericCalls.set = 0;
    iosState.genericCalls.remove = 0;
    vi.resetModules();
  });

  it('stores critical E2EE material only in the app-local iOS bridge', async () => {
    const store = await loadSecureStore();

    await store.secureSetCriticalSecret('device-signing', 'private-jwk');

    expect(iosState.keychain.get('forsure.secure.v1:device-signing')).toBe('private-jwk');
    expect(iosState.preferences.size).toBe(0);
    expect(iosState.genericSecureStore.size).toBe(0);
    expect(iosState.genericCalls).toEqual({ get: 0, set: 0, remove: 0 });
    await expect(store.secureGetCriticalSecret('device-signing')).resolves.toBe('private-jwk');
  });

  it('survives a simulated WKWebView/IndexedDB/Preferences purge and app reload', async () => {
    let store = await loadSecureStore();
    await store.secureSetCriticalSecret('device-kx', 'stable-private-key');

    // Simulate iOS removing every WebKit-owned cache while the native Keychain survives.
    iosState.preferences.clear();
    iosState.genericSecureStore.clear();
    vi.resetModules();

    store = await loadSecureStore();
    await expect(store.secureGetCriticalSecret('device-kx')).resolves.toBe('stable-private-key');
    expect(iosState.genericCalls).toEqual({ get: 0, set: 0, remove: 0 });
  });

  it('fails closed when the native iOS bridge is unavailable', async () => {
    iosState.bridgeUnavailable = true;
    const store = await loadSecureStore();

    await expect(store.secureSetCriticalSecret('spk', 'private-jwk'))
      .rejects.toThrow('E2EE_NATIVE_KEYCHAIN_UNAVAILABLE:set');
    expect(iosState.preferences.size).toBe(0);
    expect(iosState.genericSecureStore.size).toBe(0);
  });

  it('rejects a write whose mandatory native readback differs', async () => {
    iosState.corruptReadback = true;
    const store = await loadSecureStore();

    await expect(store.secureSetCriticalSecret('opk', 'private-jwk'))
      .rejects.toThrow('E2EE_NATIVE_KEYCHAIN_UNAVAILABLE:set');
    expect(iosState.preferences.size).toBe(0);
  });

  it('rejects a deletion when the native item remains readable', async () => {
    const store = await loadSecureStore();
    await store.secureSetCriticalSecret('consumed-opk', 'private-jwk');
    iosState.stickyDelete = true;

    await expect(store.secureRemoveCriticalSecret('consumed-opk'))
      .rejects.toThrow('E2EE_NATIVE_KEYCHAIN_UNAVAILABLE:remove');
  });
});
