import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  ensureApprovedDeviceTrust: vi.fn(),
  peekDeviceSignedPrekey: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
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

import { invalidateVerifiedDeviceCache, listDevicesForUser } from '../deviceRegistry';

function route(deviceId: string, key = 'A'.repeat(44)) {
  return { device_id: deviceId, device_public_key: key, platform: 'web', last_seen_at: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateVerifiedDeviceCache();
  mocks.ensureApprovedDeviceTrust.mockResolvedValue(undefined);
  mocks.peekDeviceSignedPrekey.mockResolvedValue({ signedPrekeyId: 1 });
});

describe('canonical trust-gated device registry', () => {
  it('returns only routes verified against the device authorization', async () => {
    mocks.rpc.mockResolvedValue({ data: [route('dev-good'), route('dev-bad')], error: null });
    mocks.ensureApprovedDeviceTrust.mockImplementation(async (_userId: string, deviceId: string) => {
      if (deviceId === 'dev-bad') throw new Error('BAD_DEVICE_AUTHORIZATION');
    });
    const devices = await listDevicesForUser('user-123', { verifyPrekeys: false });
    expect(devices.map((device) => device.deviceId)).toEqual(['dev-good']);
  });

  it('returns no route when the server has no ready device', async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    await expect(listDevicesForUser('user-empty')).resolves.toEqual([]);
  });

  it('fails closed when the canonical RPC is unavailable', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new Error('rpc down') });
    await expect(listDevicesForUser('user-down')).rejects.toThrow('E2EE_DEVICE_REGISTRY_UNAVAILABLE');
  });

  it('drops malformed rows before cryptographic verification', async () => {
    mocks.rpc.mockResolvedValue({ data: [route('dev-a'), route('dev-empty', '')], error: null });
    const devices = await listDevicesForUser('user-x', { verifyPrekeys: false });
    expect(devices.map((device) => device.deviceId)).toEqual(['dev-a']);
    expect(mocks.ensureApprovedDeviceTrust).toHaveBeenCalledTimes(1);
  });

  it('fails closed when every server route fails verification', async () => {
    mocks.rpc.mockResolvedValue({ data: [route('dev-bad')], error: null });
    mocks.ensureApprovedDeviceTrust.mockRejectedValue(new Error('BAD_DEVICE_AUTHORIZATION'));
    await expect(listDevicesForUser('user-bad', { verifyPrekeys: false }))
      .rejects.toThrow('E2EE_DEVICE_REGISTRY_INVALID');
  });

  it('requires a current signed prekey by default', async () => {
    mocks.rpc.mockResolvedValue({ data: [route('dev-current')], error: null });
    mocks.peekDeviceSignedPrekey.mockResolvedValue(null);
    await expect(listDevicesForUser('user-no-spk')).rejects.toThrow('E2EE_DEVICE_REGISTRY_INVALID');
  });
});
