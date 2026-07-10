import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accountRespond: vi.fn(),
  deviceRespond: vi.fn(),
  getCurrentDeviceId: vi.fn(() => 'device-1234567890abcdef'),
  isDeviceIdTemporary: vi.fn(() => false),
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: mocks.getCurrentDeviceId,
  isDeviceIdTemporary: mocks.isDeviceIdTemporary,
}));

vi.mock('./x3dh', () => ({
  x3dhRespond: mocks.accountRespond,
  x3dhRespondForDevice: mocks.deviceRespond,
}));

import { x3dhRespond } from './x3dhSafe';

const keys = {} as any;
const result = { sharedSecret: new ArrayBuffer(32), spkKeyPair: {} as CryptoKeyPair };

describe('x3dhSafe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentDeviceId.mockReturnValue('device-1234567890abcdef');
    mocks.isDeviceIdTemporary.mockReturnValue(false);
    mocks.accountRespond.mockResolvedValue(result);
    mocks.deviceRespond.mockResolvedValue(result);
  });

  it('routes OPK handshakes to the device responder', async () => {
    const initial = { ik: 'ik', ek: 'ek', spkId: 7, opkId: 9 };
    await x3dhRespond(keys, 'user-id', initial);

    expect(mocks.deviceRespond).toHaveBeenCalledWith(
      keys,
      'user-id',
      'device-1234567890abcdef',
      initial,
    );
    expect(mocks.accountRespond).not.toHaveBeenCalled();
  });

  it('keeps legacy account 3-DH messages on the account responder', async () => {
    const initial = { ik: 'ik', ek: 'ek', spkId: 7 };
    await x3dhRespond(keys, 'user-id', initial);

    expect(mocks.accountRespond).toHaveBeenCalledWith(keys, 'user-id', initial);
    expect(mocks.deviceRespond).not.toHaveBeenCalled();
  });

  it('fails closed while the device identifier is temporary', async () => {
    mocks.isDeviceIdTemporary.mockReturnValue(true);
    await expect(x3dhRespond(keys, 'user-id', {
      ik: 'ik',
      ek: 'ek',
      spkId: 7,
      opkId: 9,
    })).rejects.toThrow('X3DH_DEVICE_ID_NOT_STABLE');

    expect(mocks.deviceRespond).not.toHaveBeenCalled();
    expect(mocks.accountRespond).not.toHaveBeenCalled();
  });
});
