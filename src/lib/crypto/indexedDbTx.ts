/**
 * Hardened IndexedDB transaction helper for the E2EE singleton DB.
 *
 * Goals (Safari/iOS-first):
 *  - Single entry point for all crypto IndexedDB writes/reads.
 *  - FIFO write queue per store-set to prevent concurrent transactions on
 *    the same object stores (the #1 source of "database connection is closing").
 *  - Exponential retry on transient errors that Safari throws when the page
 *    is backgrounded or ITP wipes storage:
 *      * InvalidStateError
 *      * TransactionInactiveError
 *      * "database connection is closing"
 *  - Strict transaction pattern: the user-supplied `fn` MUST stay synchronous
 *    relative to the transaction — no awaiting external promises inside.
 *    `runTx` requests, awaits `complete`, returns the value.
 */

import { openE2EEDB, reopenE2EEDB, isIndexedDBClosingError } from './indexedDb';
import { openDB as openRegistryDB, reopenDB as reopenRegistryDB, type DBKey } from './dbRegistry';

type TxMode = 'readonly' | 'readwrite';

interface QueueEntry {
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const queues = new Map<string, QueueEntry[]>();
const running = new Set<string>();

function queueKey(dbKey: DBKey, stores: string[]): string {
  return dbKey + '::' + [...stores].sort().join('|');
}

function enqueue<T>(dbKey: DBKey, stores: string[], run: () => Promise<T>): Promise<T> {
  const key = queueKey(dbKey, stores);
  return new Promise<T>((resolve, reject) => {
    const list = queues.get(key) ?? [];
    list.push({ run: run as () => Promise<unknown>, resolve: resolve as (v: unknown) => void, reject });
    queues.set(key, list);
    void drain(key);
  });
}

async function drain(key: string) {
  if (running.has(key)) return;
  running.add(key);
  try {
    const list = queues.get(key);
    while (list && list.length > 0) {
      const entry = list.shift()!;
      try {
        const value = await entry.run();
        entry.resolve(value);
      } catch (e) {
        entry.reject(e);
      }
    }
  } finally {
    running.delete(key);
  }
}

const TRANSIENT_BACKOFF_MS = [50, 150, 400];

function isTransient(err: unknown): boolean {
  if (isIndexedDBClosingError(err)) return true;
  if (err instanceof DOMException) {
    return err.name === 'InvalidStateError' || err.name === 'TransactionInactiveError' || err.name === 'AbortError';
  }
  const msg = String((err as { message?: string } | undefined)?.message ?? err ?? '');
  return msg.includes('database connection is closing') ||
    msg.includes('transaction has finished') ||
    msg.includes('signal is aborted');
}

/**
 * Run a strict IndexedDB transaction.
 *
 * `fn` MUST only call IDBObjectStore methods synchronously and return either
 * the raw IDBRequest, a Promise resolving with the value, or a plain value.
 * Do NOT await unrelated promises inside `fn` — Safari will mark the tx
 * inactive between microtasks.
 */
export async function runTx<T>(
  stores: string[],
  mode: TxMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return runTxOn('e2ee-keys', stores, mode, fn);
}

/**
 * Same as `runTx` but targets a specific registered IndexedDB (see
 * `dbRegistry.ts`). All cross-DB writes/reads in the E2EE stack must go
 * through this — never call `indexedDB.open` directly.
 */
export async function runTxOn<T>(
  dbKey: DBKey,
  stores: string[],
  mode: TxMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return enqueue(dbKey, stores, async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= TRANSIENT_BACKOFF_MS.length; attempt++) {
      try {
        const db =
          dbKey === 'e2ee-keys'
            ? attempt === 0
              ? await openE2EEDB()
              : await reopenE2EEDB()
            : attempt === 0
              ? await openRegistryDB(dbKey)
              : await reopenRegistryDB(dbKey);
        const tx = db.transaction(stores, mode);
        const completion = new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
        });
        let value: T;
        try {
          value = await Promise.resolve(fn(tx));
        } catch (fnErr) {
          // Always observe the transaction completion promise. If an IDBRequest
          // rejects first, Safari/Chromium may still fire `onabort` afterwards;
          // leaving that promise unobserved becomes a global unhandledrejection.
          await completion.catch(() => undefined);
          throw fnErr;
        }
        await completion;
        return value;
      } catch (err) {
        lastErr = err;
        if (!isTransient(err) || attempt === TRANSIENT_BACKOFF_MS.length) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, TRANSIENT_BACKOFF_MS[attempt]));
      }
    }
    throw lastErr;
  });
}

/** Convenience helpers built on `runTx` (E2EE singleton DB). */

export function txGet<T>(store: string, id: IDBValidKey): Promise<T | undefined> {
  return runTx([store], 'readonly', (tx) =>
    new Promise<T | undefined>((resolve, reject) => {
      const req = tx.objectStore(store).get(id);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    }),
  );
}

export function txPut<T>(store: string, value: T): Promise<void> {
  return runTx([store], 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      const req = tx.objectStore(store).put(value as unknown as IDBValidKey | object);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }),
  );
}

export function txDelete(store: string, id: IDBValidKey): Promise<void> {
  return runTx([store], 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      const req = tx.objectStore(store).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }),
  );
}

export function txClear(store: string): Promise<void> {
  return runTx([store], 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      const req = tx.objectStore(store).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    }),
  );
}

/** Helper: turn an IDBRequest into a Promise. Use inside `runTxOn` callbacks. */
export function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
