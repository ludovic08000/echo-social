import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  canonicalDeviceEnrollmentPossessionPayload,
  hashDeviceEnrollmentNonce,
} from '../deviceEnrollmentPossession';

const migration = readFileSync(
  'supabase/migrations/20260806130000_bind_device_possession_to_exact_challenge.sql',
  'utf8',
).toLowerCase();
const liveExpiryGuard = readFileSync(
  'supabase/migrations/20260806153000_enforce_current_device_approval_challenge.sql',
  'utf8',
).toLowerCase();
const enrollmentClient = readFileSync('src/lib/crypto/serverDeviceEnrollment.ts', 'utf8');
const approvalFunction = readFileSync(
  'supabase/functions/approve-device-enrollment/index.ts',
  'utf8',
);

describe('device enrollment possession proof', () => {
  it('hashes the nonce deterministically before signing', async () => {
    await expect(hashDeviceEnrollmentNonce('n'.repeat(44))).resolves.toBe(
      '64b0c22e28f94394b347e63d5133181512bc0d5bcc3bd54fd961ca393765a784',
    );
  });

  it('builds one canonical challenge-bound payload', () => {
    expect(canonicalDeviceEnrollmentPossessionPayload({
      challengeId: '123e4567-e89b-42d3-a456-426614174000',
      deviceId: 'dev_0123456789abcdef0123456789abcdef',
      nonceHash: 'ABCDEF',
      expiresAt: '2026-08-06T15:00:00+00:00',
      accountFingerprint: 'AA BB CC DD',
      devicePublicKey: 'kx',
      deviceSigningKey: 'sig',
    })).toBe(JSON.stringify({
      protocol: 'forsure-aegis-device-possession',
      version: 1,
      challengeId: '123e4567-e89b-42d3-a456-426614174000',
      deviceId: 'dev_0123456789abcdef0123456789abcdef',
      nonceHash: 'abcdef',
      expiresAt: '2026-08-06T15:00:00.000Z',
      accountFingerprint: 'AA BB CC DD',
      devicePublicKey: 'kx',
      deviceSigningKey: 'sig',
    }));
  });

  it('signs possession with the device private key before completion', () => {
    expect(enrollmentClient).toContain('signDeviceEnrollmentPossession');
    expect(enrollmentClient).toContain('deviceSigningPrivateKey: authorization.deviceSigning.privateKey');
    expect(enrollmentClient).toContain('p_device_possession_signature: possessionSignature');
  });

  it('verifies the device signature over the exact stored challenge', () => {
    expect(approvalFunction).toContain('forsure-aegis-device-possession');
    expect(approvalFunction).toContain('device.approval_challenge_id');
    expect(approvalFunction).toContain('challenge.device_possession_signature');
    expect(approvalFunction).toContain('device.device_signing_key');
    expect(approvalFunction).toContain('DEVICE_POSSESSION_SIGNATURE_INVALID');
    expect(approvalFunction).toContain('p_challenge_id: challenge.id');
  });

  it('rejects an expired challenge before server finalization', () => {
    expect(approvalFunction).toContain('consumedAt > expiresAt');
    expect(approvalFunction).toContain('expiresAt <= Date.now()');
    expect(approvalFunction).toContain('DEVICE_ENROLLMENT_EXPIRED');
  });

  it('binds finalization transactionally to one timely-consumed challenge', () => {
    expect(migration).toContain('approval_challenge_id');
    expect(migration).toContain('device_possession_signature');
    expect(migration).toContain('v_device.approval_challenge_id is distinct from p_challenge_id');
    expect(migration).toContain('v_challenge.device_possession_signature is distinct from trim(p_device_possession_signature)');
    expect(migration).toContain('v_challenge.consumed_at > v_challenge.expires_at');
    expect(migration).toContain('device_approval_challenge_binding_required');
    expect(migration).toContain('to service_role');
  });

  it('requires the exact challenge to remain unexpired at finalization time', () => {
    expect(liveExpiryGuard).toContain('challenge.id = p_challenge_id');
    expect(liveExpiryGuard).toContain('challenge.user_id = p_user_id');
    expect(liveExpiryGuard).toContain('challenge.device_id = trim(p_device_id)');
    expect(liveExpiryGuard).toContain('v_challenge.expires_at <= v_now');
    expect(liveExpiryGuard).toContain('v_challenge.consumed_at > v_challenge.expires_at');
    expect(liveExpiryGuard).toContain('device_possession_proof_changed');
    expect(liveExpiryGuard).toContain('to service_role');
  });
});
