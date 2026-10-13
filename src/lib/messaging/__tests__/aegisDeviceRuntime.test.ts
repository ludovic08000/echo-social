import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureIdentity: vi.fn(),
  ensureTrust: vi.fn(),
  getDeviceId: vi.fn(),
  hydrate: vi.fn(),
  isTemporary: vi.fn(),
  setScope: vi.fn(),
  getState: vi.fn(),
  prepareKeys: vi.fn(),
}));

vi.mock('@/lib/crypto/identityBootstrap', () => ({
  ensureUserE2EEIdentity: mocks.ensureIdentity,
}));

vi.mock('@/lib/crypto/deviceLinkTrust', () => ({
  ensureApprovedDeviceTrust: mocks.ensureTrust,
}));

vi.mock('@/lib/api/deviceApi', () => ({
  deviceApi: {getState:mocks.getState,prepareKeys:mocks.prepareKeys},
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
  mocks.ensureTrust.mockResolvedValue(undefined);
  mocks.prepareKeys.mockResolvedValue(undefined);
  mocks.getState.mockResolvedValue({requiresExplicitEnrollment:false,record:{
    deviceId:'device-stable',approvalStatus:'approved',bindingStatus:'bound',
    routingStatus:'ready',isActive:true,revokedAt:null,
  }});
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
    expect(mocks.ensureTrust).toHaveBeenCalledTimes(1);
    expect(mocks.ensureTrust).toHaveBeenCalledWith('user-one', 'device-stable');
  });

  it('never exposes a temporary device to fan-out', async () => {
    mocks.isTemporary.mockReturnValue(true);

    await expect(ensureAegisDeviceReady('user-one'))
      .rejects.toThrow('E2EE_STABLE_DEVICE_REQUIRED');
    expect(mocks.ensureIdentity).not.toHaveBeenCalled();
    expect(mocks.ensureTrust).not.toHaveBeenCalled();
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
    expect(mocks.ensureTrust).toHaveBeenCalledTimes(1);
  });

  it.each(['DEVICE_ROUTE_NOT_READY','DEVICE_NOT_FOUND'])(
    'republishes the approved local proof then re-verifies a route missing with %s',async (code) => {
      mocks.ensureTrust.mockRejectedValueOnce(new Error(code));
      await expect(ensureAegisDeviceReady('user-one')).resolves.toMatchObject({deviceId:'device-stable'});
      expect(mocks.prepareKeys).toHaveBeenCalledWith('user-one');
      expect(mocks.prepareKeys).toHaveBeenCalledTimes(1);
      expect(mocks.ensureTrust).toHaveBeenCalledTimes(2);
      expect(mocks.prepareKeys.mock.invocationCallOrder[0]).toBeLessThan(mocks.ensureTrust.mock.invocationCallOrder[1]);
    });

  it.each([
    {record:null}, {requiresExplicitEnrollment:true},
    {record:{deviceId:'another-installation'}}, {record:{approvalStatus:'pending'}},
    {record:{bindingStatus:'pending'}}, {record:{isActive:false}}, {record:{revokedAt:'2026-10-12'}},
  ])('does not re-enroll or repair a missing route with unauthorized state %j',async (patch) => {
    const snapshot = await mocks.getState();
    mocks.getState.mockResolvedValue({...snapshot,...patch,
      record:patch.record === null ? null : {...snapshot.record,...patch.record},
    });
    mocks.ensureTrust.mockRejectedValueOnce(new Error('DEVICE_NOT_FOUND'));
    await expect(ensureAegisDeviceReady('user-one')).rejects.toThrow('DEVICE_NOT_FOUND');
    expect(mocks.prepareKeys).not.toHaveBeenCalled();
  });

  it('does not trust a claimed repair until the canonical registry verifies it',async () => {
    mocks.ensureTrust.mockRejectedValueOnce(new Error('DEVICE_NOT_FOUND'))
      .mockRejectedValueOnce(new Error('DEVICE_AUTHORIZATION_INVALID'));
    await expect(ensureAegisDeviceReady('user-one')).rejects.toThrow('DEVICE_AUTHORIZATION_INVALID');
    expect(mocks.prepareKeys).toHaveBeenCalledTimes(1);
    mocks.ensureTrust.mockResolvedValueOnce(undefined);
    await ensureAegisDeviceReady('user-one');
    expect(mocks.hydrate).toHaveBeenCalledTimes(2); // aucun succès mis en cache avant vérification
  });

  it('does not repair rejected signatures or registry network failures',async () => {
    for (const code of ['DEVICE_AUTHORIZATION_INVALID','ACCOUNT_IDENTITY_BINDING_INVALID','DEVICE_REGISTRY_LOOKUP_FAILED']) {
      mocks.ensureTrust.mockRejectedValueOnce(new Error(code));
      await expect(ensureAegisDeviceReady('user-one')).rejects.toThrow(code);
    }
    expect(mocks.getState).not.toHaveBeenCalled();
    expect(mocks.prepareKeys).not.toHaveBeenCalled();
  });
});
