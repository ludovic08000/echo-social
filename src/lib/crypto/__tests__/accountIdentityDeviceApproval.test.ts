import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  invoke: vi.fn(),
  loadIdentityKeys: vi.fn(),
  getOrCreateIdentityKeys: vi.fn(),
  exportPublicKeyBundle: vi.fn(),
  signDeviceAuthorization: vi.fn(),
  sign: vi.fn(),
}));

const query = {
  select: vi.fn(() => query),
  eq: vi.fn(() => query),
  order: vi.fn(() => query),
  limit: vi.fn(() => query),
  maybeSingle: mocks.maybeSingle,
};

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(() => query),
    functions: { invoke: mocks.invoke },
  },
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  loadIdentityKeys: mocks.loadIdentityKeys,
  exportPublicKeyBundle: mocks.exportPublicKeyBundle,
}));

vi.mock('@/lib/crypto/keyManagerSafe', () => ({
  getOrCreateIdentityKeys: mocks.getOrCreateIdentityKeys,
}));

vi.mock('@/lib/crypto/deviceIdentity', () => ({
  loadDeviceIdentity: vi.fn(),
  signDeviceAuthorization: mocks.signDeviceAuthorization,
}));

vi.mock('@/lib/crypto/cryptoIntegrity', () => ({
  hardCrypto: { sign: mocks.sign },
}));

import {
  canonicalAccountIdentityDeviceApprovalPayload,
  submitAccountIdentityDeviceApproval,
} from '@/lib/crypto/deviceApprovalDecision';

const userId = '11111111-1111-4111-8111-111111111111';
const deviceId = `dev_${'b'.repeat(32)}`;
const challengeId = '22222222-2222-4222-8222-222222222222';
const fingerprint = 'AA11 BB22 CC33 DD44 EE55 FF66 7788 9900 AABB CCDD';
const target = {
  deviceId,
  challengeId,
  devicePublicKey: 'k'.repeat(44),
  deviceSigningKey: 'd'.repeat(44),
};
const identity = {
  fingerprint,
  signingPrivateKey: {} as CryptoKey,
};
const bundle = {
  identityKey: 'i'.repeat(44),
  signingKey: 's'.repeat(44),
  fingerprint,
  bindingVersion: 1,
  bindingSignature: 'b'.repeat(88),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sign.mockResolvedValue(new Uint8Array(64).buffer);
  mocks.exportPublicKeyBundle.mockResolvedValue(bundle);
  mocks.signDeviceAuthorization.mockResolvedValue('a'.repeat(88));
});

describe('account identity device approval', () => {
  it('approves a pending device after restoring the pinned account identity', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { fingerprint }, error: null });
    mocks.loadIdentityKeys.mockResolvedValue(identity);
    mocks.invoke.mockResolvedValue({
      data: { ok: true, code: 'DEVICE_APPROVED', mode: 'account_recovery', device_id: deviceId },
      error: null,
    });

    await expect(submitAccountIdentityDeviceApproval({ userId, target }))
      .resolves.toEqual({ deviceId, mode: 'account_recovery' });

    expect(mocks.getOrCreateIdentityKeys).not.toHaveBeenCalled();
    expect(mocks.signDeviceAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      deviceId,
      accountFingerprint: fingerprint,
      devicePublicKey: target.devicePublicKey,
      deviceSigningKey: target.deviceSigningKey,
    }));
    expect(mocks.invoke).toHaveBeenCalledWith('recover-device-enrollment', {
      body: expect.objectContaining({
        mode: 'account_recovery',
        target_device_id: deviceId,
        target_challenge_id: challengeId,
        target_device_authorization_signature: 'a'.repeat(88),
        account_recovery_signature: expect.any(String),
      }),
    });
  });

  it('bootstraps exactly the first device when no server account identity exists', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
    mocks.loadIdentityKeys.mockResolvedValue(null);
    mocks.getOrCreateIdentityKeys.mockResolvedValue(identity);
    mocks.invoke.mockResolvedValue({
      data: { ok: true, code: 'DEVICE_APPROVED', mode: 'first_device_bootstrap', device_id: deviceId },
      error: null,
    });

    await expect(submitAccountIdentityDeviceApproval({ userId, target }))
      .resolves.toEqual({ deviceId, mode: 'first_device_bootstrap' });

    expect(mocks.getOrCreateIdentityKeys).toHaveBeenCalledWith(userId);
    expect(mocks.invoke).toHaveBeenCalledWith('recover-device-enrollment', {
      body: expect.objectContaining({ mode: 'first_device_bootstrap' }),
    });
  });

  it('fails closed when the restored identity does not match the server fingerprint', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { fingerprint }, error: null });
    mocks.loadIdentityKeys.mockResolvedValue({
      ...identity,
      fingerprint: '0011 2233 4455 6677 8899 AABB CCDD EEFF 0011 2233',
    });

    await expect(submitAccountIdentityDeviceApproval({ userId, target }))
      .rejects.toThrow('ACCOUNT_RECOVERY_IDENTITY_MISMATCH');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('binds the recovery signature to the exact challenge and target keys', () => {
    const payload = canonicalAccountIdentityDeviceApprovalPayload({
      mode: 'account_recovery',
      userId,
      target,
      accountFingerprint: fingerprint,
      deviceAuthorizationSignature: 'a'.repeat(88),
    });
    const parsed = JSON.parse(payload) as Record<string, unknown>;

    expect(parsed).toMatchObject({
      protocol: 'forsure-aegis-account-device-recovery-approval',
      version: 1,
      mode: 'account_recovery',
      userId,
      targetDeviceId: deviceId,
      targetChallengeId: challengeId,
      targetDevicePublicKey: target.devicePublicKey,
      targetDeviceSigningKey: target.deviceSigningKey,
      accountFingerprint: fingerprint,
      decision: 'approve',
    });
  });
});
