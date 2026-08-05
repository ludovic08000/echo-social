import { describe, expect, it } from 'vitest';
import {
  parseCompletedDeviceEnrollment,
  parseDeviceEnrollmentChallenge,
} from '../serverDeviceEnrollment';

const DEVICE_ID = 'dev_0123456789abcdef0123456789abcdef';
const CHALLENGE_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('server-assigned device enrollment', () => {
  it('accepts a valid short-lived server challenge', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    expect(parseDeviceEnrollmentChallenge({
      ok: true,
      code: 'DEVICE_ENROLLMENT_CHALLENGE_CREATED',
      challenge_id: CHALLENGE_ID,
      device_id: DEVICE_ID,
      nonce: 'n'.repeat(44),
      expires_at: expiresAt,
    })).toEqual({
      challengeId: CHALLENGE_ID,
      deviceId: DEVICE_ID,
      nonce: 'n'.repeat(44),
      expiresAt,
    });
  });

  it('rejects a client-shaped or expired DeviceID response', () => {
    expect(() => parseDeviceEnrollmentChallenge({
      ok: true,
      challenge_id: CHALLENGE_ID,
      device_id: 'windows-client-selected-id',
      nonce: 'n'.repeat(44),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    })).toThrow('DEVICE_ENROLLMENT_INVALID_DEVICE_ID');

    expect(() => parseDeviceEnrollmentChallenge({
      ok: true,
      challenge_id: CHALLENGE_ID,
      device_id: DEVICE_ID,
      nonce: 'n'.repeat(44),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    })).toThrow('DEVICE_ENROLLMENT_EXPIRED');
  });

  it('preserves the server rejection code', () => {
    expect(() => parseDeviceEnrollmentChallenge({
      ok: false,
      code: 'DEVICE_ENROLLMENT_RATE_LIMITED',
    })).toThrow('DEVICE_ENROLLMENT_RATE_LIMITED');
  });

  it('requires completion to return the challenged DeviceID', () => {
    expect(parseCompletedDeviceEnrollment({
      ok: true,
      code: 'DEVICE_ENROLLMENT_COMPLETED',
      device_id: DEVICE_ID,
    }, DEVICE_ID)).toBe(DEVICE_ID);

    expect(() => parseCompletedDeviceEnrollment({
      ok: true,
      device_id: 'dev_ffffffffffffffffffffffffffffffff',
    }, DEVICE_ID)).toThrow('DEVICE_ENROLLMENT_SERVER_ID_MISMATCH');
  });
});
