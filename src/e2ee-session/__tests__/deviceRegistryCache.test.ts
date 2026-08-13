import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listActiveDevices: vi.fn(),
  peekDeviceSignedPrekey: vi.fn(),
  ensureApprovedDeviceTrust: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.listActiveDevices },
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'self-device',
  isDeviceIdTemporary: () => false,
}));

vi.mock('@/lib/crypto/deviceLinkTrust', () => ({
  ensureApprovedDeviceTrust: mocks.ensureApprovedDeviceTrust,
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
    mocks.listActiveDevices.mockReset();
    mocks.ensureApprovedDeviceTrust.mockReset();
    mocks.peekDeviceSignedPrekey.mockReset();
    mocks.ensureApprovedDeviceTrust.mockResolvedValue(undefined);
    mocks.listActiveDevices.mockResolvedValue({ data: [{
      device_id: 'device-a', device_public_key: 'public-key-a', platform: 'ios', last_seen_at: null,
    }], error: null });
  });

  it('reuses a recently verified signed device list for warm sends', async () => {
    const first = await listDevicesForUser('user-a', { verifyPrekeys: false });
    first[0].devicePublicKey = 'mutated-by-caller';

    const second = await listDevicesForUser('user-a', { verifyPrekeys: false });

    expect(mocks.listActiveDevices).toHaveBeenCalledTimes(1);
    expect(second).toEqual([{
      userId: 'user-a',
      deviceId: 'device-a',
      devicePublicKey: 'public-key-a',
      lastSeen: undefined,
    }]);
  });

  it('surfaces canonical registry verification failures', async () => {
    mocks.listActiveDevices.mockResolvedValueOnce({ data: null, error: { message: 'network' } });

    await expect(listDevicesForUser('user-b', { verifyPrekeys: false }))
      .rejects.toThrow('E2EE_DEVICE_REGISTRY_UNAVAILABLE');
  });

  it('does not cache a stale in-flight empty list after invalidation', async () => {
    let release!: (value: unknown) => void;
    mocks.listActiveDevices.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));

    const stale = listDevicesForUser('user-c', { verifyPrekeys: false });
    invalidateVerifiedDeviceCache('user-c');
    release({ data: [], error: null });
    await expect(stale).resolves.toEqual([]);

    mocks.listActiveDevices.mockResolvedValueOnce({ data: [{
      device_id: 'device-c', device_public_key: 'public-key-c', platform: 'windows', last_seen_at: null,
    }], error: null });

    await expect(listDevicesForUser('user-c', { verifyPrekeys: false }))
      .resolves.toEqual([expect.objectContaining({ deviceId: 'device-c' })]);
    expect(mocks.listActiveDevices).toHaveBeenCalledTimes(2);
  });
});
