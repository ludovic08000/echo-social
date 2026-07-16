import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchVerifiedDeviceList: vi.fn(),
  peekDeviceSignedPrekey: vi.fn(),
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'self-device',
  isDeviceIdTemporary: () => false,
}));

vi.mock('@/lib/crypto/signedDeviceList', () => ({
  fetchVerifiedDeviceList: mocks.fetchVerifiedDeviceList,
}));

vi.mock('@/lib/crypto/x3dh', () => ({
  peekDeviceSignedPrekey: mocks.peekDeviceSignedPrekey,
}));

import {
  invalidateVerifiedDeviceCache,
  listDevicesForUser,
} from '@/e2ee-session/deviceRegistry';

describe('verified device routing cache', () => {
  beforeEach(() => {
    invalidateVerifiedDeviceCache();
    mocks.fetchVerifiedDeviceList.mockReset();
    mocks.peekDeviceSignedPrekey.mockReset();
    mocks.fetchVerifiedDeviceList.mockResolvedValue({
      signedListPresent: true,
      trusted: [{
        deviceId: 'device-a',
        devicePublicKey: 'public-key-a',
        isPrimary: true,
        primaryDeviceId: null,
        primaryPubB64: 'root',
        signatureB64: null,
        signedAt: null,
      }],
      verifications: [{ deviceId: 'device-a', ok: true, reason: 'PRIMARY' }],
    });
  });

  it('reuses a recently verified signed device list for warm sends', async () => {
    const first = await listDevicesForUser('user-a', { verifyPrekeys: false });
    first[0].devicePublicKey = 'mutated-by-caller';

    const second = await listDevicesForUser('user-a', { verifyPrekeys: false });

    expect(mocks.fetchVerifiedDeviceList).toHaveBeenCalledTimes(1);
    expect(second).toEqual([{
      userId: 'user-a',
      deviceId: 'device-a',
      devicePublicKey: 'public-key-a',
      lastSeen: undefined,
    }]);
  });

  it('remains fail-closed when signed routing cannot be verified', async () => {
    mocks.fetchVerifiedDeviceList.mockRejectedValueOnce(new Error('network'));

    await expect(listDevicesForUser('user-b', { verifyPrekeys: false }))
      .resolves.toEqual([]);
  });
});
