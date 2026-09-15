import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DB_NAME,
  LEGACY_E2EE_OBJECT_STORES,
  STORE_KEYS,
} from '../constants';
import { ensureE2EEObjectStores, removeLegacyE2EEObjectStores } from '../indexedDb';

const vault = vi.hoisted(() => ({
  records: ['signal-store::u::d', 'x3dh-prekey::u::d'],
  removed: [] as string[],
}));

vi.mock('../deviceVault', () => ({
  listDeviceVaultStorageIds: async (prefix: string) =>
    vault.records.filter((record) => record.startsWith(prefix)),
  removeDeviceVaultRecord: async (storageId: string) => {
    vault.removed.push(storageId);
  },
}));

import {
  cleanupLegacyCryptoStorage,
  LEGACY_CRYPTO_CLEANUP_MARKER,
  LEGACY_CRYPTO_DATABASES,
} from '../legacyCryptoStorageCleanup';

function openDatabase(
  name: string,
  version: number,
  upgrade?: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function put(db: IDBDatabase, storeName: string, value: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function get<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

describe('Libsignal-only local storage cleanup', () => {
  beforeEach(() => {
    localStorage.removeItem(LEGACY_CRYPTO_CLEANUP_MARKER);
    vault.removed.length = 0;
  });

  it('removes old object stores while preserving Aegis identity data', async () => {
    const name = `schema-cutover-${crypto.randomUUID()}`;
    let db = await openDatabase(name, 1, (upgradeDb) => {
      upgradeDb.createObjectStore(STORE_KEYS, { keyPath: 'id' });
      for (const store of LEGACY_E2EE_OBJECT_STORES) upgradeDb.createObjectStore(store);
    });
    await put(db, STORE_KEYS, { id: 'identity', value: 'preserved' });
    db.close();

    db = await openDatabase(name, 2, (upgradeDb) => {
      removeLegacyE2EEObjectStores(upgradeDb);
      ensureE2EEObjectStores(upgradeDb);
    });

    expect([...db.objectStoreNames]).toEqual([STORE_KEYS]);
    expect(await get<{ id: string; value: string }>(db, STORE_KEYS, 'identity')).toEqual({
      id: 'identity',
      value: 'preserved',
    });
    db.close();
    indexedDB.deleteDatabase(name);
  });

  it('deletes only the allowlisted legacy databases and vault prefixes', async () => {
    for (const name of LEGACY_CRYPTO_DATABASES) {
      const db = await openDatabase(name, 1);
      db.close();
    }

    const result = await cleanupLegacyCryptoStorage();
    const names = (await indexedDB.databases()).map((database) => database.name);

    expect(result).toEqual({
      complete: true,
      removedDatabases: LEGACY_CRYPTO_DATABASES.length,
      removedVaultRecords: 2,
    });
    expect(names).not.toEqual(expect.arrayContaining([...LEGACY_CRYPTO_DATABASES]));
    expect(names).toContain(DB_NAME);
    expect(vault.removed).toEqual(vault.records);
    expect(localStorage.getItem(LEGACY_CRYPTO_CLEANUP_MARKER)).toBe('1');
  });
});
