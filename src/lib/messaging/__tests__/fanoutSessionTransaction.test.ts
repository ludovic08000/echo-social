import { beforeEach, describe, expect, it, vi } from 'vitest';

type StoredRecord = Record<string, unknown> & { id: string };

const state = vi.hoisted(() => ({
  stores: {
    sessions: new Map<string, StoredRecord>(),
    'initiating-sessions': new Map<string, StoredRecord>(),
  },
}));

vi.mock('@/lib/crypto/deviceSessionQueue', () => ({
  runDeviceSessionJob: vi.fn(async (
    _scope: string,
    _key: string,
    job: () => Promise<unknown>,
  ) => job()),
}));

vi.mock('@/lib/crypto/indexedDbTx', () => ({
  reqToPromise: vi.fn(async (request: { value?: StoredRecord }) => request.value),
  runTxOn: vi.fn(async (
    _database: string,
    _stores: string[],
    _mode: string,
    operation: (tx: { objectStore: (name: keyof typeof state.stores) => unknown }) => unknown,
  ) => operation({
    objectStore(name: keyof typeof state.stores) {
      const store = state.stores[name];
      return {
        get(key: string) {
          return { value: store.get(key) };
        },
        put(record: StoredRecord) {
          store.set(record.id, structuredClone(record));
        },
        delete(key: string) {
          store.delete(key);
        },
      };
    },
  })),
}));

import {
  __test__,
  captureFanoutSessionBeforeMutation,
  hasFanoutSessionTransaction,
  rollbackFanoutSessionTarget,
  rollbackFanoutSessionTransaction,
} from '../fanoutSessionTransaction';

function pairKey(peerDeviceId: string): string {
  return `me::sender-device::peer::${peerDeviceId}`;
}

beforeEach(() => {
  __test__.reset();
  state.stores.sessions.clear();
  state.stores['initiating-sessions'].clear();
});

describe('fan-out ratchet transaction', () => {
  it('rolls back only a failed target and preserves successful target snapshots', async () => {
    const firstKey = pairKey('device-a');
    const secondKey = pairKey('device-b');
    state.stores.sessions.set(firstKey, { id: firstKey, counter: 1 });
    state.stores.sessions.set(secondKey, { id: secondKey, counter: 2 });

    for (const peerDeviceId of ['device-a', 'device-b']) {
      await captureFanoutSessionBeforeMutation({
        messageId: 'message-1',
        myUserId: 'me',
        myDeviceId: 'sender-device',
        peerUserId: 'peer',
        peerDeviceId,
      });
    }

    state.stores.sessions.set(firstKey, { id: firstKey, counter: 10 });
    state.stores.sessions.set(secondKey, { id: secondKey, counter: 20 });

    await expect(rollbackFanoutSessionTarget({
      messageId: 'message-1',
      myUserId: 'me',
      myDeviceId: 'sender-device',
      peerUserId: 'peer',
      peerDeviceId: 'device-a',
    })).resolves.toBe(true);

    expect(state.stores.sessions.get(firstKey)?.counter).toBe(1);
    expect(state.stores.sessions.get(secondKey)?.counter).toBe(20);
    expect(hasFanoutSessionTransaction('message-1')).toBe(true);

    await expect(rollbackFanoutSessionTransaction('message-1')).resolves.toBe(1);
    expect(state.stores.sessions.get(secondKey)?.counter).toBe(2);
    expect(hasFanoutSessionTransaction('message-1')).toBe(false);
  });
});
