import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  invoke: vi.fn(),
  loadDeviceIdentity: vi.fn(),
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
  return { ...original, loadDeviceIdentity: mocks.loadDeviceIdentity };
});

vi.mock('@/lib/crypto/deviceEnrollmentPossession', () => ({
  signDeviceEnrollmentPossession: mocks.signPossession,
}));

import {
  approveServerAssignedDevice,
  beginServerAssignedDeviceEnrollment,
  completeServerAssignedDeviceEnrollment,
} from '@/lib/crypto/serverDeviceEnrollment';
import {
  __test__ as deviceEnrollmentGateTest,
  authorizeExplicitDeviceEnrollment,
} from '@/lib/crypto/deviceEnrollmentGate';
import {
  canonicalDeviceApprovalDecisionPayload,
  submitDeviceApprovalDecision,
} from '@/lib/crypto/deviceApprovalDecision';

const userId = '11111111-1111-4111-8111-111111111111';
const windowsId = `dev_${'a'.repeat(32)}`;
const iphoneId = `dev_${'b'.repeat(32)}`;
const challengeId = '22222222-2222-4222-8222-222222222222';
const expiresAt = new Date(Date.now() + 60_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  deviceEnrollmentGateTest.reset();
});

describe('simulated Chrome iPhone enrollment', () => {
  it('stages the iOS device as pending without calling the approval function', async () => {
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
      if (name === 'complete_user_device_enrollment') {
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

    authorizeExplicitDeviceEnrollment('user_requested_new_device');
    const challenge = await beginServerAssignedDeviceEnrollment({
      deviceName: 'Chrome · iPhone',
      deviceFingerprint: 'ios-test-fingerprint',
      platform: 'ios',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/140 Mobile/15E148 Safari/604.1',
    });

    const deviceId = await completeServerAssignedDeviceEnrollment(challenge, {
      account: {
        identityKey: 'i'.repeat(44),
        signingKey: 's'.repeat(44),
        fingerprint: 'AA11 BB22 CC33 DD44 EE55 FF66 7788 9900 AABB CCDD',
        bindingVersion: 1,
        bindingSignature: 'a'.repeat(88),
      },
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
      authorizationSignature: 'z'.repeat(88),
    });

    expect(deviceId).toBe(iphoneId);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('fails closed when legacy code tries to let the iPhone approve itself', async () => {
    await expect(approveServerAssignedDevice(iphoneId))
      .rejects.toThrow('DEVICE_APPROVAL_REQUIRES_TRUSTED_DEVICE');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe('approved Windows device decision', () => {
  it('signs the exact target and invokes the approval endpoint', async () => {
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

    const target = {
      deviceId: iphoneId,
      challengeId,
      devicePublicKey: 'k'.repeat(44),
      deviceSigningKey: 'd'.repeat(44),
    };
    const payload = canonicalDeviceApprovalDecisionPayload({
      userId,
      approverDeviceId: windowsId,
      target,
      decision: 'approve',
    });

    await expect(submitDeviceApprovalDecision({
      userId,
      approverDeviceId: windowsId,
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
    expect(call.body).toMatchObject({
      decision: 'approve',
      approver_device_id: windowsId,
      target_device_id: iphoneId,
      target_challenge_id: challengeId,
    });
  });

  it('refuses self-approval before any network call', async () => {
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
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
