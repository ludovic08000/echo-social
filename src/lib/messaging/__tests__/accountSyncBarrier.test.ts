import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_SYNC_WAIT_TIMEOUT_MS,
  beginAccountSynchronization,
  getAccountSynchronizationError,
  getAccountSynchronizationPhase,
  resetAccountSynchronization,
  waitForAccountSynchronization,
} from '@/lib/messaging/accountSyncBarrier';

beforeEach(() => {
  resetAccountSynchronization();
});

describe('account synchronization barrier', () => {
  it('blocks message waiters until the account refresh completes', async () => {
    let release!: () => void;
    const operation = new Promise<void>((resolve) => {
      release = resolve;
    });

    const synchronization = beginAccountSynchronization('user-one', () => operation);
    await Promise.resolve();
    expect(getAccountSynchronizationPhase('user-one')).toBe('syncing');

    let passed = false;
    const waiter = waitForAccountSynchronization('user-one').then(() => {
      passed = true;
    });
    await Promise.resolve();
    expect(passed).toBe(false);

    release();
    await synchronization;
    await waiter;
    expect(passed).toBe(true);
    expect(getAccountSynchronizationPhase('user-one')).toBe('ready');
  });

  it('shares one synchronization operation between concurrent callers', async () => {
    const operation = vi.fn(async () => undefined);
    const ignoredOperation = vi.fn(async () => undefined);

    const first = beginAccountSynchronization('user-one', operation);
    const second = beginAccountSynchronization('user-one', ignoredOperation);

    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(ignoredOperation).not.toHaveBeenCalled();
  });

  it('surfaces the failure to the sync initiator without latching senders', async () => {
    await expect(beginAccountSynchronization('user-one', async () => {
      throw new Error('sync exploded');
    })).rejects.toThrow('sync exploded');

    expect(getAccountSynchronizationPhase('user-one')).toBe('failed');
    expect(getAccountSynchronizationError('user-one')).toBe('SYNC_EXPLODED');
    // ensureAegisDeviceReady reste l'autorité crypto: la barrière ne bloque pas.
    await expect(waitForAccountSynchronization('user-one')).resolves.toBeUndefined();
  });

  it('stops waiting after the bounded 8s window', async () => {
    vi.useFakeTimers();
    try {
      void beginAccountSynchronization('user-slow', () => new Promise<void>(() => undefined))
        .catch(() => undefined);
      let released = false;
      const waiter = waitForAccountSynchronization('user-slow').then(() => { released = true; });
      await vi.advanceTimersByTimeAsync(ACCOUNT_SYNC_WAIT_TIMEOUT_MS - 1);
      expect(released).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await waiter;
      expect(released).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not block users without a pending synchronization', async () => {
    await expect(waitForAccountSynchronization('user-two')).resolves.toBeUndefined();
    expect(getAccountSynchronizationPhase('user-two')).toBe('idle');
  });
});
