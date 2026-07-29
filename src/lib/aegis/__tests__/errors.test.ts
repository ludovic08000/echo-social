
import { describe, expect, it } from 'vitest';
import { failureStatus } from '../core/errors';

 describe('Aegis error classification', () => {
  it('keeps route failures waiting for the secure channel', () => {
    expect(failureStatus(new Error('E2EE_DEVICE_COPIES_UNAVAILABLE')))
      .toBe('waiting_secure_channel');
  });

  it('makes authentication and PIN failures visible', () => {
    expect(failureStatus(new Error('401 JWT unauthorized'))).toBe('failed_visible');
    expect(failureStatus(new Error('PIN unlock required'))).toBe('failed_visible');
  });

  it('retries ambiguous transport failures', () => {
    expect(failureStatus(new Error('NETWORK_TRANSPORT_TIMEOUT'))).toBe('retry_pending');
  });
});
