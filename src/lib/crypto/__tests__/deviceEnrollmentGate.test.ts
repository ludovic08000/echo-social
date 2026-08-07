import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __test__,
  authorizeExplicitDeviceEnrollment,
  consumeExplicitDeviceEnrollmentAuthorization,
  hasExplicitDeviceEnrollmentAuthorization,
} from '../deviceEnrollmentGate';

describe('explicit device enrollment gate', () => {
  beforeEach(() => {
    __test__.reset();
    vi.useRealTimers();
  });

  it('rejects automatic enrollment without a user grant', () => {
    expect(() => consumeExplicitDeviceEnrollmentAuthorization())
      .toThrow('DEVICE_ENROLLMENT_REQUIRES_EXPLICIT_USER_ACTION');
  });

  it('allows one enrollment after an explicit action', () => {
    authorizeExplicitDeviceEnrollment('local_key_lost');
    expect(hasExplicitDeviceEnrollmentAuthorization()).toBe(true);
    expect(consumeExplicitDeviceEnrollmentAuthorization()).toBe('local_key_lost');
    expect(() => consumeExplicitDeviceEnrollmentAuthorization())
      .toThrow('DEVICE_ENROLLMENT_REQUIRES_EXPLICIT_USER_ACTION');
  });

  it('expires the one-shot grant', () => {
    vi.useFakeTimers();
    authorizeExplicitDeviceEnrollment('user_requested_new_device');
    vi.advanceTimersByTime(__test__.grantTtlMs + 1);
    expect(() => consumeExplicitDeviceEnrollmentAuthorization())
      .toThrow('DEVICE_ENROLLMENT_REQUIRES_EXPLICIT_USER_ACTION');
  });
});
