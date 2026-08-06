import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  loadDeviceIdentity: vi.fn(),
  loadIdentityKeys: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke: mocks.invoke } },
}));

vi.mock('@/lib/crypto/deviceIdentity', () => ({
  loadDeviceIdentity: mocks.loadDeviceIdentity,
  signDeviceAuthorization: vi.fn(),
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  loadIdentityKeys: mocks.loadIdentityKeys,
}));

import { submitDeviceApprovalDecision } from '@/lib/crypto/deviceApprovalDecision';

const userId = '11111111-1111-4111-8111-111111111111';
const windowsId = `dev_${'a'.repeat(32)}`;
const iphoneId = `dev_${'b'.repeat(32)}`;
const challengeId = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('trusted device rejection', () => {
  it('maps a signed refusal to an immediate device revocation without account restoration', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    mocks.loadDeviceIdentity.mockResolvedValue({
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      publicB64: 'w'.repeat(44),
    });
    mocks.invoke.mockResolvedValue({
      data: { ok: true, code: 'DEVICE_REVOKED', device_id: iphoneId },
      error: null,
    });

    await expect(submitDeviceApprovalDecision({
      userId,
      approverDeviceId: windowsId,
      target: {
        deviceId: iphoneId,
        challengeId,
        devicePublicKey: 'k'.repeat(44),
        deviceSigningKey: 'd'.repeat(44),
      },
      decision: 'reject',
    })).resolves.toEqual({ deviceId: iphoneId, decision: 'reject' });

    expect(mocks.loadIdentityKeys).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith('approve-device-enrollment', {
      body: expect.objectContaining({
        decision: 'reject',
        approver_device_id: windowsId,
        target_device_id: iphoneId,
        target_challenge_id: challengeId,
        target_device_authorization_signature: null,
        approver_signature: expect.any(String),
      }),
    });
  });

  it('fails closed if the server does not confirm revocation', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    mocks.loadDeviceIdentity.mockResolvedValue({
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
      publicB64: 'w'.repeat(44),
    });
    mocks.invoke.mockResolvedValue({
      data: { ok: true, code: 'DEVICE_APPROVED', device_id: iphoneId },
      error: null,
    });

    await expect(submitDeviceApprovalDecision({
      userId,
      approverDeviceId: windowsId,
      target: {
        deviceId: iphoneId,
        challengeId,
        devicePublicKey: 'k'.repeat(44),
        deviceSigningKey: 'd'.repeat(44),
      },
      decision: 'reject',
    })).rejects.toThrow('DEVICE_APPROVAL_DECISION_INVALID_RESPONSE');
  });
});
