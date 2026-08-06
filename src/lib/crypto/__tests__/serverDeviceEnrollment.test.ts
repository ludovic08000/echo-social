import { describe, expect, it } from 'vitest';
import {
  isRegisteredDeviceReusable,
  parseApprovedDevice,
  parseCompletedDeviceEnrollment,
  parseDeviceEnrollmentChallenge,
  parseDeviceEnrollmentSettlement,
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

  it('requires explicit approval to return the completed DeviceID', () => {
    expect(parseApprovedDevice({
      ok: true,
      code: 'DEVICE_APPROVED',
      device_id: DEVICE_ID,
    }, DEVICE_ID)).toBe(DEVICE_ID);

    expect(() => parseApprovedDevice({
      ok: true,
      code: 'DEVICE_APPROVED',
      device_id: 'dev_ffffffffffffffffffffffffffffffff',
    }, DEVICE_ID)).toThrow('DEVICE_APPROVAL_SERVER_ID_MISMATCH');

    expect(() => parseApprovedDevice({
      ok: false,
      code: 'DEVICE_NOT_ELIGIBLE',
    }, DEVICE_ID)).toThrow('DEVICE_NOT_ELIGIBLE');
  });

  it('rejects a successful approval response with the wrong status code', () => {
    expect(() => parseApprovedDevice({
      ok: true,
      code: 'DEVICE_ENROLLMENT_COMPLETED',
      device_id: DEVICE_ID,
    }, DEVICE_ID)).toThrow('DEVICE_APPROVAL_INVALID_RESPONSE');
  });

  it('recovers a server commit after an ambiguous HTTP response', () => {
    expect(parseDeviceEnrollmentSettlement({
      ok: true,
      code: 'DEVICE_ENROLLMENT_ALREADY_COMPLETED',
      device_id: DEVICE_ID,
    }, DEVICE_ID)).toEqual({ status: 'completed', deviceId: DEVICE_ID });
  });

  it('confirms cancellation before provisional keys may be deleted', () => {
    expect(parseDeviceEnrollmentSettlement({
      ok: true,
      code: 'DEVICE_ENROLLMENT_CANCELLED',
      device_id: DEVICE_ID,
    }, DEVICE_ID)).toEqual({ status: 'cancelled', deviceId: DEVICE_ID });

    expect(() => parseDeviceEnrollmentSettlement({
      ok: false,
      code: 'DEVICE_ENROLLMENT_INVALID_NONCE',
    }, DEVICE_ID)).toThrow('DEVICE_ENROLLMENT_INVALID_NONCE');
  });

  it('refuses to reuse a Windows DeviceID from an iOS runtime', () => {
    expect(isRegisteredDeviceReusable('web', 'ios')).toBe(false);
    expect(isRegisteredDeviceReusable('ios', 'web')).toBe(false);
    expect(isRegisteredDeviceReusable('ios', 'ios')).toBe(true);
    expect(isRegisteredDeviceReusable('web', 'web')).toBe(true);
  });

  it('refuses revoked, inactive, rejected or crypto-invalid routes', () => {
    const healthy = {
      isActive: true,
      approvalStatus: 'approved',
      revokedAt: null,
      cryptoInvalidAt: null,
    };

    expect(isRegisteredDeviceReusable('ios', 'ios', healthy)).toBe(true);
    expect(isRegisteredDeviceReusable('ios', 'ios', {
      ...healthy,
      isActive: false,
    })).toBe(false);
    expect(isRegisteredDeviceReusable('ios', 'ios', {
      ...healthy,
      approvalStatus: 'rejected',
    })).toBe(false);
    expect(isRegisteredDeviceReusable('ios', 'ios', {
      ...healthy,
      revokedAt: '2026-08-05T00:00:00.000Z',
    })).toBe(false);
    expect(isRegisteredDeviceReusable('ios', 'ios', {
      ...healthy,
      cryptoInvalidAt: '2026-08-05T00:00:00.000Z',
    })).toBe(false);
  });
});
