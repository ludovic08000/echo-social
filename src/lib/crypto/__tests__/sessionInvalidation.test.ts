import { beforeEach, describe, expect, it, vi } from 'vitest';
const invalidate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../libsignalSessionFreshness', () => ({ invalidateLibsignalSessions: invalidate }));
import { startSessionInvalidationWatcher } from '../sessionInvalidation';

describe('security events renew the current Libsignal sessions', () => {
  beforeEach(() => {
    invalidate.mockClear();
    startSessionInvalidationWatcher();
  });
  it.each(['forsure-e2ee-security-epoch-changed', 'forsure-e2ee-security-code-changed'])('routes %s to the event owner only', event => {
    startSessionInvalidationWatcher();
    window.dispatchEvent(new CustomEvent(event, { detail: { userId: 'alice' } }));
    expect(invalidate).toHaveBeenCalledExactlyOnceWith('alice');
  });
  it('does not clear unrelated accounts on a malformed event', () => {
    window.dispatchEvent(new CustomEvent('forsure-e2ee-security-epoch-changed'));
    expect(invalidate).not.toHaveBeenCalled();
  });
});
