import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), account: vi.fn(), binding: vi.fn(), authorization: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {
  rpc: mocks.rpc,
  from: () => {
    const query = { select: () => query, eq: () => query, order: () => query, limit: () => query, maybeSingle: mocks.account };
    return query;
  },
} }));
vi.mock('../keyManager', () => ({ verifyPublicIdentityBinding: mocks.binding }));
vi.mock('../deviceIdentity', () => ({ verifyDeviceAuthorization: mocks.authorization }));
import { getApprovedDeviceIdentity } from '../deviceLinkTrust';

const device = { device_id: 'requested-device', device_public_key: 'kx', device_signing_key: 'signing',
  device_authorization_signature: 'proof', approval_status: 'approved', binding_status: 'bound',
  routing_status: 'ready', is_active: true, revoked_at: null, stale_at: null, crypto_invalid_at: null };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.rpc.mockResolvedValue({ data: device, error: null });
  mocks.account.mockResolvedValue({ data: { identity_key: 'account-kx', signing_key: 'account-signing',
    fingerprint: 'pinned-account', identity_binding_signature: 'binding', identity_binding_version: 1 }, error: null });
  mocks.binding.mockResolvedValue(true);
  mocks.authorization.mockResolvedValue(true);
});

describe('the canonical identity belongs to the exact requested device', () => {
  it.each([device, [device]])('accepts the canonical RPC object or singleton array', async (data) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(getApprovedDeviceIdentity('alice', 'requested-device')).resolves.toMatchObject({
      deviceId: 'requested-device', accountFingerprint: 'pinned-account', deviceSigningKey: 'signing',
    });
    expect(mocks.authorization).toHaveBeenCalledWith(expect.objectContaining({ userId: 'alice', deviceId: 'requested-device' }));
  });
  it.each([{ ...device, device_id: 'another-device' }, [{ ...device, device_id: 'another-device' }], [device, device], 'invalid'])(
    'rejects substituted or ambiguous registry responses before trusting them', async (data) => {
      mocks.rpc.mockResolvedValue({ data, error: null });
      await expect(getApprovedDeviceIdentity('alice', 'requested-device')).rejects.toThrow('DEVICE_AUTHORIZATION_INVALID');
      expect(mocks.authorization).not.toHaveBeenCalled();
    });
  it('still rejects a revoked device with a matching identifier', async () => {
    mocks.rpc.mockResolvedValue({ data: { ...device, revoked_at: '2026-10-12' }, error: null });
    await expect(getApprovedDeviceIdentity('alice', 'requested-device')).rejects.toThrow('DEVICE_ROUTE_NOT_AUTHORIZED');
  });
  it('still rejects an invalid account authorization', async () => {
    mocks.authorization.mockResolvedValue(false);
    await expect(getApprovedDeviceIdentity('alice', 'requested-device')).rejects.toThrow('DEVICE_AUTHORIZATION_INVALID');
  });
});
