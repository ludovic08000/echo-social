import { describe, it, expect, beforeAll } from 'vitest';
import { runTx, txPut, txGet, txDelete, txClear } from '../indexedDbTx';
import { openE2EEDB, ensureE2EEObjectStores } from '../indexedDb';
import { STORE_KEYS } from '../constants';

beforeAll(async () => {
  // Force the singleton open so the schema exists in fake-indexeddb.
  const db = await openE2EEDB();
  ensureE2EEObjectStores(db);
});

describe('indexedDbTx (Safari-safe helper)', () => {
  it('round-trips put/get/delete', async () => {
    const value = { id: 'abc', payload: 'x' };
    await txPut(STORE_KEYS, value);
    const round = await txGet<typeof value>(STORE_KEYS, 'abc');
    expect(round?.payload).toBe('x');
    await txDelete(STORE_KEYS, 'abc');
    expect(await txGet(STORE_KEYS, 'abc')).toBeUndefined();
  });

  it('serialises concurrent writes on the same store (no overlapping tx)', async () => {
    await txClear(STORE_KEYS);
    const writes = Array.from({ length: 25 }, (_, i) =>
      txPut(STORE_KEYS, { id: `k-${i}`, n: i }),
    );
    await Promise.all(writes);
    for (let i = 0; i < 25; i++) {
      const row = await txGet<{ id: string; n: number }>(STORE_KEYS, `k-${i}`);
      expect(row?.n).toBe(i);
    }
  });

  it('runTx returns the value produced by the supplied fn', async () => {
    await txPut(STORE_KEYS, { id: 'count', n: 7 });
    const n = await runTx([STORE_KEYS], 'readonly', (tx) =>
      new Promise<number>((resolve, reject) => {
        const req = tx.objectStore(STORE_KEYS).get('count');
        req.onsuccess = () => resolve((req.result as { n: number }).n);
        req.onerror = () => reject(req.error);
      }),
    );
    expect(n).toBe(7);
  });
});
