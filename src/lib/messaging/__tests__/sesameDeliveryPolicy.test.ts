import { describe, expect, it } from 'vitest';
import {
  classifySesameDeliveryFailure,
  computeRetryDelayForFailure,
  shouldOfferSesameRetry,
} from '../sesameDeliveryPolicy';

describe('Sesame delivery failure policy', () => {
  it('blocks automatic retry when an identity key changes', () => {
    const failure = classifySesameDeliveryFailure({
      name: 'OutgoingIdentityKeyError',
      message: 'The identity of contact has changed.',
    });
    expect(failure.kind).toBe('identity-changed');
    expect(failure.retryMode).toBe('after-user-action');
    expect(shouldOfferSesameRetry(failure)).toBe(false);
  });

  it('refreshes devices after a device-list mismatch', () => {
    const failure = classifySesameDeliveryFailure(new Error('MismatchedDevicesError: missing devices'));
    expect(failure.kind).toBe('device-mismatch');
    expect(failure.shouldRefreshDevices).toBe(true);
    expect(failure.retryMode).toBe('automatic');
  });

  it('respects a rate-limit retryAt value', () => {
    const now = 10_000;
    const failure = classifySesameDeliveryFailure({
      status: 429,
      message: 'Too many requests',
      retryAfterMs: 8_000,
    }, now);
    expect(failure.kind).toBe('rate-limited');
    expect(computeRetryDelayForFailure(failure, 4, now, () => 0)).toBe(8_000);
  });

  it('retries network and server failures automatically', () => {
    expect(classifySesameDeliveryFailure(new TypeError('Failed to fetch')).retryMode).toBe('automatic');
    expect(classifySesameDeliveryFailure({ status: 503, message: 'Unavailable' }).kind).toBe('server');
  });

  it('does not retry invalid payloads unchanged', () => {
    const failure = classifySesameDeliveryFailure({ status: 413, message: 'Message too large' });
    expect(failure.kind).toBe('invalid-payload');
    expect(failure.retryMode).toBe('never');
  });

  it('keeps unknown errors manually recoverable', () => {
    const failure = classifySesameDeliveryFailure('Something unexpected happened');
    expect(failure.kind).toBe('unknown');
    expect(failure.retryMode).toBe('manual');
    expect(shouldOfferSesameRetry(failure)).toBe(true);
  });
});
