import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: vi.fn(() => 'web'),
  native: vi.fn(() => false),
  capabilities: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: mocks.platform },
  registerPlugin: () => ({ getCapabilities: mocks.capabilities }),
}));
vi.mock('@/lib/runtimePlatform', () => ({ isVerifiedNativeRuntime: mocks.native }));
vi.mock('../deviceVault', () => ({ readDeviceVaultRecord: vi.fn(), writeDeviceVaultRecord: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  mocks.platform.mockReturnValue('web');
  mocks.native.mockReturnValue(false);
  mocks.capabilities.mockReset();
});

it('reports the current WASM backend on web instead of the retired WebCrypto engine', async () => {
  const { getLibsignalBackendInfo } = await import('../libsignalPlatformBridge');
  await expect(getLibsignalBackendInfo()).resolves.toMatchObject({ kind: 'wasm', engine: 'signalapp/libsignal-rust-wasm' });
  expect(mocks.capabilities).not.toHaveBeenCalled();
});

it.each(['android', 'ios'])('reports the verified native backend on %s', async (platform) => {
  mocks.platform.mockReturnValue(platform);
  mocks.native.mockReturnValue(true);
  mocks.capabilities.mockResolvedValue({ available: true, engine: 'signalapp/libsignal', platform, abiVersion: 1 });
  const { getLibsignalBackendInfo } = await import('../libsignalPlatformBridge');
  await expect(getLibsignalBackendInfo()).resolves.toMatchObject({ kind: 'native', platform, abiVersion: 1 });
});

it('does not hide a native ABI mismatch behind a WASM fallback', async () => {
  mocks.platform.mockReturnValue('android');
  mocks.native.mockReturnValue(true);
  mocks.capabilities.mockResolvedValue({ available: true, platform: 'android', abiVersion: 999 });
  const { getLibsignalBackendInfo } = await import('../libsignalPlatformBridge');
  await expect(getLibsignalBackendInfo()).rejects.toThrow('AEGIS_LIBSIGNAL_NATIVE_ABI_MISMATCH');
});
