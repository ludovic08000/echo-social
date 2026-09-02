import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getPlatform: vi.fn(() => 'web'),
  getCapabilities: vi.fn(),
  runSelfTest: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: mocks.getPlatform },
  registerPlugin: () => ({ getCapabilities: mocks.getCapabilities, runSelfTest: mocks.runSelfTest }),
}));

describe('libsignalNative', () => {
  beforeEach(() => {
    mocks.getPlatform.mockReturnValue('web');
    mocks.getCapabilities.mockReset();
  });

  it('keeps Aegis WebCrypto on the web', async () => {
    const { getLibSignalCapabilities } = await import('../libsignalNative');
    await expect(getLibSignalCapabilities()).resolves.toMatchObject({ available: false, engine: 'aegis-webcrypto' });
    expect(mocks.getCapabilities).not.toHaveBeenCalled();
  });

  it('uses the native plugin on Android', async () => {
    mocks.getPlatform.mockReturnValue('android');
    mocks.getCapabilities.mockResolvedValue({ available: true, engine: 'signalapp/libsignal' });
    const { getLibSignalCapabilities } = await import('../libsignalNative');
    await expect(getLibSignalCapabilities()).resolves.toMatchObject({ available: true });
  });
});