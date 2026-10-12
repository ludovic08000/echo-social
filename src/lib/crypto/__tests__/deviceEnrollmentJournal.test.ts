import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ db: null as IDBDatabase | null }));
vi.mock('../indexedDb', () => ({
  openE2EEDB: async () => h.db,
  reopenE2EEDB: async () => h.db,
  isIndexedDBClosingError: () => false,
}));
import { STORE_KEYS } from '../constants';
import { readEnrollmentJournal, writeEnrollmentJournal, clearEnrollmentJournal } from '../deviceEnrollmentJournal';
import { reqToPromise, runTx } from '../indexedDbTx';

const challenge = {
  deviceId: `dev_${'a'.repeat(32)}`, challengeId: '11111111-1111-4111-8111-111111111111',
  nonce: 'a'.repeat(64), expiresAt: '2020-01-01T00:00:00.000Z',
};
let factory: IDBFactory;
async function open() {
  const request = factory.open('journal', 1);
  request.onupgradeneeded = () => request.result.createObjectStore(STORE_KEYS, { keyPath: 'id' });
  h.db = await reqToPromise(request);
}
beforeEach(async () => { factory = new IDBFactory(); await open(); });
afterEach(() => h.db?.close());
describe('durable enrollment journal', () => {
  it('survives reopening storage, including an expired challenge which still needs settlement', async () => {
    await writeEnrollmentJournal('alice', challenge);
    h.db?.close(); await open();
    expect(await readEnrollmentJournal('alice')).toEqual(challenge);
    expect(await readEnrollmentJournal('bob')).toBeNull();
    await clearEnrollmentJournal('bob');
    expect(await readEnrollmentJournal('alice')).toEqual(challenge);
    await clearEnrollmentJournal('alice');
    expect(await readEnrollmentJournal('alice')).toBeNull();
  });
  it('rejects a corrupt or cross-account journal without erasing it', async () => {
    await runTx([STORE_KEYS], 'readwrite', (tx) => {
      tx.objectStore(STORE_KEYS).put({ id: 'device-enrollment-pending::alice', userId: 'bob', challenge });
    });
    await expect(readEnrollmentJournal('alice')).rejects.toThrow('DEVICE_ENROLLMENT_JOURNAL_INVALID');
    expect(await runTx([STORE_KEYS], 'readonly', (tx) => reqToPromise(tx.objectStore(STORE_KEYS).count()))).toBe(1);
  });
});
