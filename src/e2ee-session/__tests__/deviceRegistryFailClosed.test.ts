import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchVerifiedDeviceList: vi.fn(),
  peekDeviceSignedPrekey: vi.fn(),
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'sender-device',
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
  listFanoutTargets,
} from '@/e2ee-session/deviceRegistry';

function validRegistry(userId: string, deviceId = `${userId}-device`) {
  return {
    signedListPresent: true,
    trusted: [{
      deviceId,
      devicePublicKey: 'A'.repeat(44),
      lastSeenAt: null,
      isRoutable: true,
    }],
    verifications: [{ deviceId, isRoutable: true, ok: true, reason: 'VALID' }],
  };
}

describe('device registry fail-closed fan-out gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateVerifiedDeviceCache();
    mocks.peekDeviceSignedPrekey.mockResolvedValue({ signedPrekeyId: 1 });
  });

  it('quarantines an invalid historical authorization while retaining a valid signed route', async () => {
    mocks.fetchVerifiedDeviceList.mockImplementation(async (userId: string) => {
      if (userId !== 'peer') return validRegistry(userId);
      return {
        signedListPresent: true,
        trusted: [{ deviceId: 'peer-valid', devicePublicKey: 'A'.repeat(44), lastSeenAt: null, isRoutable: true }],
        verifications: [
          { deviceId: 'peer-valid', isRoutable: true, ok: true, reason: 'VALID' },
          { deviceId: 'peer-invalid', isRoutable: false, ok: false, reason: 'BAD_DEVICE_AUTHORIZATION' },
        ],
      };
    });

    const targets = await listFanoutTargets('sender', ['peer'], { verifyPrekeys: false });
    expect(targets.map((target) => target.deviceId).sort()).toEqual([
      'peer-valid',
      'sender-device',
    ]);
    expect(targets.some((target) => target.deviceId === 'peer-invalid')).toBe(false);
  });

  it('fails closed when an invalid authorization is still server-routable, even if another route is valid', async () => {
    mocks.fetchVerifiedDeviceList.mockImplementation(async (userId: string) => {
      if (userId !== 'peer') return validRegistry(userId);
      return {
        signedListPresent: true,
        trusted: [{ deviceId: 'peer-valid', devicePublicKey: 'A'.repeat(44), lastSeenAt: null, isRoutable: true }],
        verifications: [
          { deviceId: 'peer-valid', isRoutable: true, ok: true, reason: 'VALID' },
          { deviceId: 'peer-invalid', isRoutable: true, ok: false, reason: 'BAD_DEVICE_AUTHORIZATION' },
        ],
      };
    });

    await expect(
      listFanoutTargets('sender', ['peer'], { verifyPrekeys: false }),
    ).rejects.toThrow('E2EE_DEVICE_REGISTRY_INVALID');
  });

  it('fails closed when a signed registry contains no valid route', async () => {
    mocks.fetchVerifiedDeviceList.mockImplementation(async (userId: string) => {
      if (userId !== 'peer') return validRegistry(userId);
      return {
        signedListPresent: true,
        trusted: [],
        verifications: [
          { deviceId: 'peer-invalid', isRoutable: true, ok: false, reason: 'BAD_DEVICE_AUTHORIZATION' },
        ],
      };
    });

    await expect(
      listFanoutTargets('sender', ['peer'], { verifyPrekeys: false }),
    ).rejects.toThrow('E2EE_DEVICE_REGISTRY_INVALID');
  });

  it('rejects the complete route when any participant has no routable device', async () => {
    mocks.fetchVerifiedDeviceList.mockImplementation(async (userId: string) =>
      userId === 'peer'
        ? {
          signedListPresent: true,
          trusted: [{ deviceId: 'peer-old', devicePublicKey: 'A'.repeat(44), lastSeenAt: null, isRoutable: false }],
          verifications: [{ deviceId: 'peer-old', isRoutable: false, ok: true, reason: 'VALID' }],
        }
        : validRegistry(userId));

    await expect(
      listFanoutTargets('sender', ['peer'], { verifyPrekeys: false }),
    ).rejects.toThrow('E2EE_DEVICE_REGISTRY_INVALID');
  });

  it('does not downgrade a registry fetch failure into a partial route', async () => {
    mocks.fetchVerifiedDeviceList.mockImplementation(async (userId: string) => {
      if (userId === 'peer') throw new Error('network');
      return validRegistry(userId);
    });

    await expect(
      listFanoutTargets('sender', ['peer'], { verifyPrekeys: false }),
    ).rejects.toThrow('E2EE_DEVICE_REGISTRY_UNAVAILABLE');
  });

  it('returns every route only after every participant registry verifies', async () => {
    mocks.fetchVerifiedDeviceList.mockImplementation(async (userId: string) => validRegistry(userId));
    const targets = await listFanoutTargets('sender', ['peer'], { verifyPrekeys: false });
    expect(targets.map((target) => target.userId).sort()).toEqual(['peer', 'sender']);
  });
});
