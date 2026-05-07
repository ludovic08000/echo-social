import { DB_NAME, DB_VERSION, STORE_KEYS, STORE_PREKEYS, STORE_SESSION } from './constants';
import { hardGlobals } from './cryptoIntegrity';

let dbPromise: Promise<IDBDatabase> | null = null;

export function ensureE2EEObjectStores(db: IDBDatabase) {
  if (!db.objectStoreNames.contains(STORE_KEYS)) {
    db.createObjectStore(STORE_KEYS, { keyPath: 'id' });
  }
  if (!db.objectStoreNames.contains(STORE_SESSION)) {
    db.createObjectStore(STORE_SESSION, { keyPath: 'conversationId' });
  }
  if (!db.objectStoreNames.contains(STORE_PREKEYS)) {
    db.createObjectStore(STORE_PREKEYS, { keyPath: 'id' });
  }
}

function resetE2EEDB() {
  dbPromise = null;
}

export function isIndexedDBClosingError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'InvalidStateError' || error.name === 'TransactionInactiveError')
  ) || String(error).includes('database connection is closing');
}

export async function safeIDB<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isIndexedDBClosingError(error)) {
      resetE2EEDB();
      console.warn('[E2EE][IDB] database connection closed; operation skipped safely');
      return fallback;
    }
    throw error;
  }
}

export function openE2EEDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = hardGlobals.idbOpen(DB_NAME, DB_VERSION);

    request.onerror = () => {
      resetE2EEDB();
      reject(request.error);
    };

    request.onsuccess = () => {
      const db = request.result;
      const closeForUpgrade = db.close.bind(db);
      // This connection is a shared singleton used by chat, calls, media upload,
      // PIN restore and key backup. Feature code must not close it after a local
      // read/write, otherwise concurrent crypto writes fail with:
      // "Failed to execute 'transaction': The database connection is closing".
      try {
        Object.defineProperty(db, 'close', {
          configurable: true,
          value: () => console.warn('[E2EE][IDB] ignored close() on shared crypto database'),
        });
      } catch {
        // Some WebViews may not allow overriding native methods; direct callers
        // are still being removed, and onversionchange uses closeForUpgrade.
      }
      db.onversionchange = () => {
        closeForUpgrade();
        resetE2EEDB();
      };
      db.onclose = () => resetE2EEDB();
      db.onerror = () => resetE2EEDB();
      resolve(db);
    };

    request.onblocked = () => {
      resetE2EEDB();
      reject(new Error('E2EE IndexedDB open blocked'));
    };

    request.onupgradeneeded = () => {
      ensureE2EEObjectStores(request.result);
    };
  });

  return dbPromise;
}
