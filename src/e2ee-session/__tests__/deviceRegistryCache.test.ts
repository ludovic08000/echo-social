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

  it('does not cache a stale in-flight empty list after invalidation', async () => {
    let release!: (value: unknown) => void;
    mocks.fetchVerifiedDeviceList.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));

    const stale = listDevicesForUser('user-c', { verifyPrekeys: false });
    invalidateVerifiedDeviceCache('user-c');
    release({ signedListPresent: false, trusted: [], verifications: [] });
    await expect(stale).resolves.toEqual([]);

    mocks.fetchVerifiedDeviceList.mockResolvedValueOnce({
      signedListPresent: true,
      trusted: [{
        deviceId: 'device-c',
        devicePublicKey: 'public-key-c',
        isPrimary: true,
        primaryDeviceId: null,
        primaryPubB64: 'root',
        signatureB64: null,
        signedAt: null,
      }],
      verifications: [{ deviceId: 'device-c', ok: true, reason: 'PRIMARY' }],
    });

    await expect(listDevicesForUser('user-c', { verifyPrekeys: false }))
      .resolves.toEqual([expect.objectContaining({ deviceId: 'device-c' })]);
    expect(mocks.fetchVerifiedDeviceList).toHaveBeenCalledTimes(2);
  });
});
