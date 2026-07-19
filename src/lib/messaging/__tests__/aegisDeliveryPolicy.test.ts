import { describe, expect, it } from 'vitest';
import {
  classifyAegisDeliveryFailure,
  computeRetryDelayForFailure,
  shouldOfferAegisRetry,
} from '../aegisDeliveryPolicy';

describe('Aegis delivery failure policy', () => {
  it('blocks automatic retry when an identity key changes', () => {
    const failure = classifyAegisDeliveryFailure({
      name: 'OutgoingIdentityKeyError',
      message: 'The identity of contact has changed.',
    });
    expect(failure.kind).toBe('identity-changed');
    expect(failure.retryMode).toBe('after-user-action');
    expect(shouldOfferAegisRetry(failure)).toBe(false);
  });

  it('refreshes devices after a device-list mismatch', () => {
    const failure = classifyAegisDeliveryFailure(new Error('MismatchedDevicesError: missing devices'));
    expect(failure.kind).toBe('device-mismatch');
    expect(failure.shouldRefreshDevices).toBe(true);
    expect(failure.retryMode).toBe('automatic');
  });

  it('respects a rate-limit retryAt value', () => {
    const now = 10_000;
    const failure = classifyAegisDeliveryFailure({
      status: 429,
      message: 'Too many requests',
      retryAfterMs: 8_000,
    }, now);
    expect(failure.kind).toBe('rate-limited');
    expect(computeRetryDelayForFailure(failure, 4, now, () => 0)).toBe(8_000);
  });

  it('retries network and server failures automatically', () => {
    expect(classifyAegisDeliveryFailure(new TypeError('Failed to fetch')).retryMode).toBe('automatic');
    expect(classifyAegisDeliveryFailure({ status: 503, message: 'Unavailable' }).kind).toBe('server');
  });

  it('does not retry invalid payloads unchanged', () => {
    const failure = classifyAegisDeliveryFailure({ status: 413, message: 'Message too large' });
    expect(failure.kind).toBe('invalid-payload');
    expect(failure.retryMode).toBe('never');
  });

  it('keeps unknown errors manually recoverable', () => {
    const failure = classifyAegisDeliveryFailure('Something unexpected happened');
    expect(failure.kind).toBe('unknown');
    expect(failure.retryMode).toBe('manual');
    expect(shouldOfferAegisRetry(failure)).toBe(true);
  });
});
