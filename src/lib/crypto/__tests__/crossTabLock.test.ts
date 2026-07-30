import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reqToPromise, runTxOn } from '@/lib/crypto/indexedDbTx';
import {
  __test__,
  CrossTabLockTimeoutError,
} from '@/lib/crypto/crossTabLock';

beforeEach(async () => {
  await __test__.clearLeases();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await __test__.clearLeases();
});

describe('cross-tab IndexedDB lock fallback', () => {
  it('serializes two independent tab owners for the same critical section', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = __test__.runWithOwner('tab-a', 'aegis:test:shared', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    }, { waitTimeoutMs: 2_000, leaseMs: 10_000 });

    while (!events.includes('first:start')) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const second = __test__.runWithOwner('tab-b', 'aegis:test:shared', async () => {
      events.push('second:start');
      events.push('second:end');
    }, { waitTimeoutMs: 2_000, leaseMs: 10_000 });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('takes over an expired lease left by a crashed tab', async () => {
    await runTxOn('msg-queue', ['leases'], 'readwrite', (tx) =>
      reqToPromise(tx.objectStore('leases').put({
        name: 'aegis:test:expired',
        ownerId: 'crashed-tab',
        token: 'dead-token',
        expiresAt: Date.now() - 1,
        updatedAt: Date.now() - 60_000,
      })),
    );

    await expect(__test__.runWithOwner(
      'replacement-tab',
      'aegis:test:expired',
      async () => 'recovered',
      { waitTimeoutMs: 500, leaseMs: 10_000 },
    )).resolves.toBe('recovered');
  });

  it('does not turn completed irreversible work into a false local failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(__test__.runWithOwner(
      'tab-a',
      'aegis:test:completed',
      async () => {
        await runTxOn('msg-queue', ['leases'], 'readwrite', (tx) =>
          reqToPromise(tx.objectStore('leases').delete('aegis:test:completed')),
        );
        return 'authoritative-commit';
      },
      { waitTimeoutMs: 500, leaseMs: 10_000 },
    )).resolves.toBe('authoritative-commit');
    expect(warn).toHaveBeenCalledWith(
      '[E2EE][LOCK] lease ownership changed after task completion',
      { name: 'aegis:test:completed' },
    );
  });

  it('times out instead of entering an active lease concurrently', async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const first = __test__.runWithOwner(
      'tab-a',
      'aegis:test:timeout',
      async () => {
        markFirstStarted();
        await firstGate;
      },
      { waitTimeoutMs: 2_000, leaseMs: 10_000 },
    );

    await firstStarted;
    await expect(__test__.runWithOwner(
      'tab-b',
      'aegis:test:timeout',
      async () => undefined,
      { waitTimeoutMs: 50, leaseMs: 10_000 },
    )).rejects.toBeInstanceOf(CrossTabLockTimeoutError);

    releaseFirst();
    await first;
  });
});
