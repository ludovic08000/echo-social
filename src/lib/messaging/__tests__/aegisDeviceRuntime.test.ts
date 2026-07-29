import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureIdentity: vi.fn(),
  getDeviceId: vi.fn(),
  hydrate: vi.fn(),
  isTemporary: vi.fn(),
  setScope: vi.fn(),
}));

vi.mock('@/lib/crypto/identityBootstrap', () => ({
  ensureUserE2EEIdentity: mocks.ensureIdentity,
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: mocks.getDeviceId,
  hydrateDeviceId: mocks.hydrate,
  isDeviceIdTemporary: mocks.isTemporary,
  setCurrentDeviceUserScope: mocks.setScope,
}));

import {
  __test__,
  ensureAegisDeviceReady,
} from '@/lib/messaging/aegisDeviceRuntime';

beforeEach(() => {
  vi.clearAllMocks();
  __test__.reset();
  mocks.getDeviceId.mockReturnValue('device-stable');
  mocks.hydrate.mockResolvedValue('device-stable');
  mocks.isTemporary.mockReturnValue(false);
  mocks.ensureIdentity.mockResolvedValue(undefined);
});

describe('Aegis stable device runtime', () => {
  it('shares one initialization between concurrent sends', async () => {
    const [first, second] = await Promise.all([
      ensureAegisDeviceReady('user-one'),
      ensureAegisDeviceReady('user-one'),
    ]);

    expect(first).toMatchObject({ deviceId: 'device-stable', userId: 'user-one' });
    expect(second).toBe(first);
    expect(mocks.hydrate).toHaveBeenCalledTimes(1);
    expect(mocks.ensureIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.ensureIdentity).toHaveBeenCalledWith('user-one', {
      waitForMaintenance: true,
    });
  });

  it('never exposes a temporary device to fan-out', async () => {
    mocks.isTemporary.mockReturnValue(true);

    await expect(ensureAegisDeviceReady('user-one'))
      .rejects.toThrow('E2EE_STABLE_DEVICE_REQUIRED');
    expect(mocks.ensureIdentity).not.toHaveBeenCalled();
  });

  it('retries initialization after a failure', async () => {
    mocks.ensureIdentity
      .mockRejectedValueOnce(new Error('prekey publication failed'))
      .mockResolvedValueOnce(undefined);

    await expect(ensureAegisDeviceReady('user-one'))
      .rejects.toThrow('prekey publication failed');
    await expect(ensureAegisDeviceReady('user-one'))
      .resolves.toMatchObject({ deviceId: 'device-stable' });

    expect(mocks.hydrate).toHaveBeenCalledTimes(2);
    expect(mocks.ensureIdentity).toHaveBeenCalledTimes(2);
  });
});
