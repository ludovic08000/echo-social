import { beforeEach, describe, expect, it, vi } from 'vitest';

const isIosWebRuntimeMock = vi.fn(() => false);
const isWindowsWebMock = vi.fn(() => false);

vi.mock('@/platforms/ios/iosRuntime', () => ({
  isIosWebRuntime: () => isIosWebRuntimeMock(),
}));

vi.mock('@/lib/crypto/windowsHelloDeviceRecovery', () => ({
  isWindowsWeb: () => isWindowsWebMock(),
  isWindowsHelloAvailable: vi.fn(async () => true),
  getWindowsHelloRecoveryStatus: vi.fn(async () => true),
  registerCurrentWindowsHelloDevice: vi.fn(async () => undefined),
  recoverCurrentWindowsHelloDevice: vi.fn(async () => 'dev_' + 'a'.repeat(32)),
}));

vi.mock('@/platforms/ios/iosPasskeyProvider', () => ({
  iosPasskeyProvider: { platform: 'ios' },
  isIosPasskeySupported: vi.fn(async () => true),
}));

import {
  detectDevicePlatformKind,
  resolveDevicePlatformProvider,
} from '@/platforms/deviceLifecycleCore';

describe('deviceLifecycleCore provider selection', () => {
  beforeEach(() => {
    isIosWebRuntimeMock.mockReturnValue(false);
    isWindowsWebMock.mockReturnValue(false);
  });

  it('sélectionne le provider iOS sur runtime iOS Web', () => {
    isIosWebRuntimeMock.mockReturnValue(true);
    expect(detectDevicePlatformKind()).toBe('ios');
    expect(resolveDevicePlatformProvider().platform).toBe('ios');
  });

  it('garde le provider Windows inchangé hors iOS', () => {
    isWindowsWebMock.mockReturnValue(true);
    expect(detectDevicePlatformKind()).toBe('windows');
    expect(resolveDevicePlatformProvider().platform).toBe('windows');
  });

  it('retombe sur un provider générique fail-closed', async () => {
    const provider = resolveDevicePlatformProvider();
    expect(provider.platform).toBe('generic');
    await expect(provider.register({ userId: 'u', deviceId: 'd' })).rejects.toThrow('DEVICE_PROVIDER_UNSUPPORTED');
  });
});
