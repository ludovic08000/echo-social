import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mocks.rpc(...args),
  },
}));

import {
  __libsignalDeviceNumberTest,
  getLibsignalDeviceNumber,
  invalidateLibsignalDeviceNumberCache,
  warmLibsignalDeviceNumbers,
} from '@/lib/crypto/libsignalDeviceNumber';

describe('Libsignal device-number cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __libsignalDeviceNumberTest.reset();
    mocks.rpc.mockImplementation(() => ({
      abortSignal: async () => ({ data: 7, error: null }),
    }));
  });

  it('coalesces concurrent reads and reuses the stable public number', async () => {
    const first = getLibsignalDeviceNumber('alice', 'device-a');
    const second = getLibsignalDeviceNumber('alice', 'device-a');

    await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
    await expect(getLibsignalDeviceNumber('alice', 'device-a')).resolves.toBe(7);

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });

  it('warms each unique route once with bounded reusable metadata', async () => {
    await warmLibsignalDeviceNumbers([
      { userId: 'alice', deviceId: 'device-a' },
      { userId: 'bob', deviceId: 'device-b' },
      { userId: 'bob', deviceId: 'device-b' },
    ]);
    await warmLibsignalDeviceNumbers([
      { userId: 'alice', deviceId: 'device-a' },
      { userId: 'bob', deviceId: 'device-b' },
    ]);

    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(__libsignalDeviceNumberTest.size()).toBe(2);
  });

  it('does not retain an invalid server value and can be explicitly invalidated', async () => {
    mocks.rpc
      .mockImplementationOnce(() => ({
        abortSignal: async () => ({ data: 0, error: null }),
      }))
      .mockImplementation(() => ({
        abortSignal: async () => ({ data: 9, error: null }),
      }));

    await expect(getLibsignalDeviceNumber('alice', 'device-a'))
      .rejects.toThrow('DEVICE_NUMBER_UNAVAILABLE');
    await expect(getLibsignalDeviceNumber('alice', 'device-a')).resolves.toBe(9);
    invalidateLibsignalDeviceNumberCache();
    await expect(getLibsignalDeviceNumber('alice', 'device-a')).resolves.toBe(9);

    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });
});
