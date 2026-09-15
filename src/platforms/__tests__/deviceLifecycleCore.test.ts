import { beforeEach, describe, expect, it, vi } from 'vitest';

const isIosRuntimeMock = vi.fn(() => false);

vi.mock('@/platforms/ios/capacitorBridge', () => ({
  isIosRuntime: () => isIosRuntimeMock(),
  isNativeIosRuntime: () => false,
  inspectIosBridge: () => ({ isNativeIos: false, isIosWeb: isIosRuntimeMock(), reportedPlatform: 'web', userAgent: '' }),
}));

import {
  detectDevicePlatformKind,
  resolveDevicePlatformProvider,
} from '@/platforms/deviceLifecycleCore';

describe('deviceLifecycleCore provider selection', () => {
  beforeEach(() => {
    isIosRuntimeMock.mockReturnValue(false);
  });

  it('détecte iOS mais reste fail-closed sans provider de récupération', () => {
    isIosRuntimeMock.mockReturnValue(true);
    expect(detectDevicePlatformKind()).toBe('ios');
    expect(resolveDevicePlatformProvider().platform).toBe('generic');
  });

  it('retombe sur un provider générique fail-closed', async () => {
    const provider = resolveDevicePlatformProvider();
    expect(provider.platform).toBe('generic');
    await expect(provider.register({ userId: 'u', deviceId: 'd' })).rejects.toThrow('DEVICE_PROVIDER_UNSUPPORTED');
  });
});
