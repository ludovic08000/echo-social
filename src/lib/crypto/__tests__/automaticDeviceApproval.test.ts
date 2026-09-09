import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
const loadDeviceIdentity = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...args: unknown[]) => rpc(...args) } }));
vi.mock('@/lib/crypto/deviceIdentity', () => ({ loadDeviceIdentity: (...a: unknown[]) => loadDeviceIdentity(...a) }));
vi.mock('@/lib/crypto/cryptoIntegrity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hardCrypto: { sign: vi.fn(async () => new Uint8Array(64).fill(7).buffer) },
}));

import { submitAutomaticDeviceApproval } from '@/lib/crypto/deviceApprovalDecision';

const USER = '11111111-1111-4111-8111-111111111111';
const DEVICE = `dev_${'a'.repeat(32)}`;
const CHALLENGE = '22222222-2222-4222-8222-222222222222';

const target = {
  deviceId: DEVICE,
  challengeId: CHALLENGE,
  devicePublicKey: 'kx-public',
  deviceSigningKey: 'signing-public',
};

beforeEach(() => {
  rpc.mockReset();
  loadDeviceIdentity.mockReset();
  loadDeviceIdentity.mockResolvedValue({ publicB64: 'signing-public', privateKey: {} });
});

describe('automatic device approval', () => {
  it('auto-approves a freshly enrolled device through the server RPC', async () => {
    rpc.mockResolvedValue({ data: { ok: true, code: 'DEVICE_APPROVED', device_id: DEVICE, device_role: 'primary' }, error: null });
    await expect(submitAutomaticDeviceApproval({ userId: USER, target })).resolves.toEqual({
      deviceId: DEVICE,
      decision: 'approve',
    });
    const [, params] = rpc.mock.calls[0] as [string, Record<string, unknown>];
    expect(params.p_approver_device_id).toBe(DEVICE);
    expect(params.p_device_id).toBe(DEVICE);
    expect(params.p_challenge_id).toBe(CHALLENGE);
  });

  it('auto-approves a device already stuck in pending (secondary role)', async () => {
    rpc.mockResolvedValue({ data: { ok: true, code: 'DEVICE_APPROVED', device_id: DEVICE, device_role: 'secondary' }, error: null });
    await expect(submitAutomaticDeviceApproval({ userId: USER, target })).resolves.toEqual({
      deviceId: DEVICE,
      decision: 'approve',
    });
  });

  it('fails closed when the user is not authenticated server-side', async () => {
    rpc.mockResolvedValue({ data: { ok: false, code: 'NOT_AUTHENTICATED' }, error: null });
    await expect(submitAutomaticDeviceApproval({ userId: USER, target })).rejects.toThrow('NOT_AUTHENTICATED');
  });

  it('refuses a device that does not belong to this account/local identity', async () => {
    loadDeviceIdentity.mockResolvedValue({ publicB64: 'another-device-signing-key', privateKey: {} });
    await expect(submitAutomaticDeviceApproval({ userId: USER, target }))
      .rejects.toThrow('DEVICE_AUTO_APPROVAL_LOCAL_IDENTITY_INVALID');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('refuses when the server rejects ownership of the device', async () => {
    rpc.mockResolvedValue({ data: { ok: false, code: 'DEVICE_NOT_FOUND' }, error: null });
    await expect(submitAutomaticDeviceApproval({ userId: USER, target })).rejects.toThrow('DEVICE_NOT_FOUND');
  });

  it('requires an authenticated caller before signing anything', async () => {
    await expect(submitAutomaticDeviceApproval({ userId: '', target })).rejects.toThrow('DEVICE_APPROVAL_USER_REQUIRED');
    expect(rpc).not.toHaveBeenCalled();
  });
});
