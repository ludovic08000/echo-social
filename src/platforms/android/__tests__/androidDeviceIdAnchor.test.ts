import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ android: true, vault: new Map<string, string>() }));

vi.mock('@/platforms/android/androidRuntime', () => ({ isAndroidRuntime: () => state.android }));
vi.mock('@/lib/secureStore', () => ({
  secureGetCriticalSecret: async (key: string) => state.vault.get(key) ?? null,
  secureSetCriticalSecret: async (key: string, value: string) => { state.vault.set(key, value); },
}));

const DEVICE_ID = 'dev_0123456789abcdef0123456789abcdef';

describe('Android device id anchor', () => {
  beforeEach(() => { state.android = true; state.vault.clear(); });

  it('restores the exact DeviceID from the Keystore anchor', async () => {
    const anchor = await import('../androidDeviceIdAnchor');
    await expect(anchor.writeAndroidDeviceIdAnchor('key:user', DEVICE_ID)).resolves.toBe(true);
    await expect(anchor.readAndroidDeviceIdAnchor('key:user')).resolves.toBe(DEVICE_ID);
  });

  it('rejects legacy IDs and is a no-op outside Android', async () => {
    const anchor = await import('../androidDeviceIdAnchor');
    await expect(anchor.writeAndroidDeviceIdAnchor('key:user', 'legacy')).resolves.toBe(false);
    state.android = false;
    await expect(anchor.writeAndroidDeviceIdAnchor('key:user', DEVICE_ID)).resolves.toBe(false);
    expect(state.vault.size).toBe(0);
  });
});
