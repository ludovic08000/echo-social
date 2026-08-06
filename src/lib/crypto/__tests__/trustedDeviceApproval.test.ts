import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
  loadDeviceIdentity: vi.fn(),
  loadIdentityKeys: vi.fn(),
  signAuthorization: vi.fn(async () => 'Y'.repeat(88)),
  signPossession: vi.fn(async () => 'c2lnbmF0dXJl'.repeat(8)),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    functions: { invoke: mocks.invoke },
  },
}));

vi.mock('@/lib/crypto/deviceIdentity', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/crypto/deviceIdentity')>();
  return {
    ...original,
    loadDeviceIdentity: mocks.loadDeviceIdentity,
    signDeviceAuthorization: mocks.signAuthorization,
  };
});

vi.mock('@/lib/crypto/keyManager', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/crypto/keyManager')>();
  return { ...original, loadIdentityKeys: mocks.loadIdentityKeys };
});

vi.mock('@/lib/crypto/deviceEnrollmentPossession', () => ({
  signDeviceEnrollmentPossession: mocks.signPossession,
}));

import {
  approveServerAssignedDevice,
  beginServerAssignedDeviceEnrollment,
  completeServerAssignedDeviceEnrollmentCandidate,
} from '@/lib/crypto/serverDeviceEnrollment';
import {
  canonicalDeviceApprovalDecisionPayload,
  submitDeviceApprovalDecision,
} from '@/lib/crypto/deviceApprovalDecision';

const userId = '11111111-1111-4111-8111-111111111111';
const approvedDeviceId = `dev_${'a'.repeat(32)}`;
const iphoneId = `dev_${'b'.repeat(32)}`;
const challengeId = '22222222-2222-4222-8222-222222222222';
const expiresAt = new Date(Date.now() + 60_000).toISOString();
const accountFingerprint = 'AA11 BB22 CC33 DD44 EE55 FF66 7788 9900 AABB CCDD';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('simulated Chrome iPhone enrollment', () => {
  it('stages the iOS device as pending without loading account private keys', async () => {
    mocks.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'begin_user_device_enrollment') {
        expect(args).toMatchObject({
          p_device_name: 'Chrome · iPhone',
          p_platform: 'ios',
        });
        expect(String(args.p_user_agent)).toContain('CriOS');
        return {
          data: {
            ok: true,
            code: 'DEVICE_ENROLLMENT_STARTED',
            challenge_id: challengeId,
            device_id: iphoneId,
            nonce: 'n'.repeat(64),
            expires_at: expiresAt,
          },
          error: null,
        };
      }
      if (name === 'complete_user_device_enrollment_candidate') {
        expect(args).toMatchObject({
          p_account_fingerprint: accountFingerprint,
          p_device_public_key: 'k'.repeat(44),
          p_device_signing_key: 'd'.repeat(44),
        });
        expect(args).not.toHaveProperty('p_device_authorization_signature');
        expect(args).not.toHaveProperty('p_account_signing_key');
        return {
          data: {
            ok: true,
            code: 'DEVICE_ENROLLMENT_COMPLETED',
            challenge_id: challengeId,
            device_id: iphoneId,
            routing_status: 'repairing',
          },
          error: null,
        };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });

    const challenge = await beginServerAssignedDeviceEnrollment({
      deviceName: 'Chrome · iPhone',
      deviceFingerprint: 'ios-test-fingerprint',
      platform: 'ios',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/140 Mobile/15E148 Safari/604.1',
    });

    const deviceId = await completeServerAssignedDeviceEnrollmentCandidate(challenge, {
      accountFingerprint,
      deviceKx: {
        publicKey: {} as CryptoKey,
        privateKey: {} as CryptoKey,
        publicB64: 'k'.repeat(44),
      },
      deviceSigning: {
        publicKey: {} as CryptoKey,
        privateKey: {} as CryptoKey,
        publicB64: 'd'.repeat(44),
      },
    });

    expect(deviceId).toBe(iphoneId);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.loadIdentityKeys).not.toHaveBeenCalled();
    expect(mocks.signAuthorization).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('fails closed when legacy code tries to let the iPhone approve itself', async () => {
    await expect(approveServerAssignedDevice(iphoneId))
      .rejects.toThrow('DEVICE_APPROVAL_REQUIRES_TRUSTED_OR_RECOVERED_ACCOUNT');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe('approved device decision', () => {
  it('signs the account authorization and exact approval decision', async () => {
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
    mocks.loadIdentityKeys.mockResolvedValue({
      fingerprint: accountFingerprint,
      signingPrivateKey: {} as CryptoKey,
    });
    mocks.invoke.mockResolvedValue({
      data: { ok: true, code: 'DEVICE_APPROVED', device_id: iphoneId },
      error: null,
    });

    const target = {
      deviceId: iphoneId,
      challengeId,
      devicePublicKey: 'k'.repeat(44),
      deviceSigningKey: 'd'.repeat(44),
    };
    const payload = canonicalDeviceApprovalDecisionPayload({
      userId,
      approverDeviceId: approvedDeviceId,
      target: {
        ...target,
        deviceAuthorizationSignature: 'Y'.repeat(88),
      },
      decision: 'approve',
    });

    await expect(submitDeviceApprovalDecision({
      userId,
      approverDeviceId: approvedDeviceId,
      target,
      decision: 'approve',
    })).resolves.toEqual({ deviceId: iphoneId, decision: 'approve' });

    const call = mocks.invoke.mock.calls[0]?.[1] as { body?: Record<string, unknown> };
    const signature = String(call.body?.approver_signature ?? '');
    const publicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    const imported = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    const signatureBytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));

    await expect(crypto.subtle.verify(
      'Ed25519',
      imported,
      signatureBytes,
      new TextEncoder().encode(payload),
    )).resolves.toBe(true);
    expect(mocks.signAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      deviceId: iphoneId,
      accountFingerprint,
    }));
    expect(call.body).toMatchObject({
      decision: 'approve',
      approver_device_id: approvedDeviceId,
      target_device_id: iphoneId,
      target_challenge_id: challengeId,
      target_device_authorization_signature: 'Y'.repeat(88),
    });
  });

  it('refuses self-approval before any account-key or network call', async () => {
    await expect(submitDeviceApprovalDecision({
      userId,
      approverDeviceId: iphoneId,
      target: {
        deviceId: iphoneId,
        challengeId,
        devicePublicKey: 'k'.repeat(44),
        deviceSigningKey: 'd'.repeat(44),
      },
      decision: 'approve',
    })).rejects.toThrow('DEVICE_SELF_APPROVAL_FORBIDDEN');
    expect(mocks.loadIdentityKeys).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
