import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  ios: true,
  vault: new Map<string, string>(),
}));

vi.mock('@/platforms/ios/capacitorBridge', () => ({
  isIosRuntime: () => state.ios,
  isNativeIosRuntime: () => state.ios,
  inspectIosBridge: () => ({
    isNativeIos: state.ios,
    reportedPlatform: state.ios ? 'ios' : 'web',
    isIosWeb: false,
    userAgent: 'iPhone',
  }),
}));

vi.mock('@/platforms/ios/keychain', () => ({
  iosKeychainGet: async (key: string) => state.vault.get(key) ?? null,
  iosKeychainSet: async (key: string, value: string) => { state.vault.set(key, value); },
  iosKeychainRemove: async (key: string) => { state.vault.delete(key); },
}));

const DEVICE_ID = 'dev_0123456789abcdef0123456789abcdef';

async function load() {
  return import('@/platforms/ios/iosDeviceIdAnchor');
}

describe('iOS device id anchor', () => {
  beforeEach(() => {
    state.ios = true;
    state.vault.clear();
    vi.resetModules();
  });

  it('persists and restores the server DeviceID after a WebKit storage purge', async () => {
    const anchor = await load();
    await expect(anchor.writeIosDeviceIdAnchor('key:user', DEVICE_ID)).resolves.toBe(true);
    // Le cache web est purgé : seul le Keychain subsiste.
    await expect(anchor.readIosDeviceIdAnchor('key:user')).resolves.toBe(DEVICE_ID);
    await expect(anchor.hasIosDeviceIdAnchor('key:user')).resolves.toBe(true);
  });

  it('never anchors a non-canonical DeviceID', async () => {
    const anchor = await load();
    await expect(anchor.writeIosDeviceIdAnchor('key:user', 'legacy-device')).resolves.toBe(false);
    expect(state.vault.size).toBe(0);
  });

  it('is a complete no-op outside iOS so Windows stays untouched', async () => {
    state.ios = false;
    const anchor = await load();
    await expect(anchor.writeIosDeviceIdAnchor('key:user', DEVICE_ID)).resolves.toBe(false);
    await expect(anchor.readIosDeviceIdAnchor('key:user')).resolves.toBeNull();
    expect(state.vault.size).toBe(0);
  });

  it('keeps the same DeviceID across app reopen (idempotent write)', async () => {
    const anchor = await load();
    await anchor.writeIosDeviceIdAnchor('key:user', DEVICE_ID);
    await anchor.writeIosDeviceIdAnchor('key:user', DEVICE_ID);
    expect([...state.vault.values()]).toEqual([DEVICE_ID]);
  });
});
