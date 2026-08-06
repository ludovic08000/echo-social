import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginAccountSynchronization,
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

  it('fails closed when the account refresh fails', async () => {
    await expect(beginAccountSynchronization('user-one', async () => {
      throw new Error('sync exploded');
    })).rejects.toThrow('sync exploded');

    expect(getAccountSynchronizationPhase('user-one')).toBe('failed');
    await expect(waitForAccountSynchronization('user-one'))
      .rejects.toThrow('ACCOUNT_SYNC_FAILED:SYNC_EXPLODED');
  });

  it('does not block users without a pending synchronization', async () => {
    await expect(waitForAccountSynchronization('user-two')).resolves.toBeUndefined();
    expect(getAccountSynchronizationPhase('user-two')).toBe('idle');
  });
});
