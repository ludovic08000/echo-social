// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { subscribeAccountKeysRestored } from '@/lib/device-manager/pinUnlockSignal';

describe('account-key restoration signals', () => {
  it('resumes approval immediately when the account Master Key is unlocked', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAccountKeysRestored('user-1', listener);

    window.dispatchEvent(new CustomEvent('forsure:e2ee-unlocked', {
      detail: { userId: 'user-1' },
    }));

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('keeps restoration events scoped to the authenticated account', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAccountKeysRestored('user-1', listener);

    window.dispatchEvent(new CustomEvent('forsure:e2ee-unlocked', {
      detail: { userId: 'user-2' },
    }));
    window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
      detail: { userId: 'user-2' },
    }));

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('removes both restoration listeners on teardown', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAccountKeysRestored('user-1', listener);
    unsubscribe();

    window.dispatchEvent(new CustomEvent('forsure:e2ee-unlocked', {
      detail: { userId: 'user-1' },
    }));
    window.dispatchEvent(new CustomEvent('forsure-keys-restored', {
      detail: { userId: 'user-1' },
    }));

    expect(listener).not.toHaveBeenCalled();
  });
});
