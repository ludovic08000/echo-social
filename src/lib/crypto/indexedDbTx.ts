import { getDb, resetDb, type DbKey } from './dbRegistry';

export function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function isRetryableIndexedDbError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return (
      error.name === 'InvalidStateError' ||
      error.name === 'TransactionInactiveError' ||
      error.name === 'NotFoundError' ||
      error.name === 'VersionError'
    );
  }
  return false;
}

type StoreInput = string | readonly string[];
type StoreResult<TStores extends StoreInput> = TStores extends string
  ? IDBObjectStore
  : Record<string, IDBObjectStore>;

function getStores<TStores extends StoreInput>(tx: IDBTransaction, storeNames: TStores): StoreResult<TStores> {
  if (typeof storeNames === 'string') {
    return tx.objectStore(storeNames) as StoreResult<TStores>;
  }

  const stores: Record<string, IDBObjectStore> = {};
  for (const storeName of storeNames) {
    stores[storeName] = tx.objectStore(storeName);
  }
  return stores as StoreResult<TStores>;
}

async function runTxOnce<T, TStores extends StoreInput>(
  dbKey: DbKey,
  storeNames: TStores,
  mode: IDBTransactionMode,
  fn: (stores: StoreResult<TStores>, tx: IDBTransaction, db: IDBDatabase) => T | Promise<T>,
): Promise<T> {
  const db = await getDb(dbKey);
  const tx = db.transaction(storeNames as string | string[], mode);
  const done = txDone(tx);

  try {
    const result = await fn(getStores(tx, storeNames), tx, db);
    await done;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {}
    throw error;
  }
}

export async function runTxOn<T, TStores extends StoreInput>(
  dbKey: DbKey,
  storeNames: TStores,
  mode: IDBTransactionMode,
  fn: (stores: StoreResult<TStores>, tx: IDBTransaction, db: IDBDatabase) => T | Promise<T>,
): Promise<T> {
  try {
    return await runTxOnce(dbKey, storeNames, mode, fn);
  } catch (error) {
    if (!isRetryableIndexedDbError(error)) throw error;
    resetDb(dbKey);
    return runTxOnce(dbKey, storeNames, mode, fn);
  }
}
