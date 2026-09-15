import {
  DB_NAME,
  DB_VERSION,
  LEGACY_E2EE_OBJECT_STORES,
  STORE_KEYS,
} from './constants';
import { hardGlobals } from './cryptoIntegrity';

let dbPromise: Promise<IDBDatabase> | null = null;

export function ensureE2EEObjectStores(db: IDBDatabase) {
  if (!db.objectStoreNames.contains(STORE_KEYS)) {
    db.createObjectStore(STORE_KEYS, { keyPath: 'id' });
  }
}

export function removeLegacyE2EEObjectStores(db: IDBDatabase) {
  for (const storeName of LEGACY_E2EE_OBJECT_STORES) {
    if (db.objectStoreNames.contains(storeName)) {
      db.deleteObjectStore(storeName);
    }
  }
}

function resetE2EEDB() {
  dbPromise = null;
}

export async function reopenE2EEDB(): Promise<IDBDatabase> {
  resetE2EEDB();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return openE2EEDB();
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
      removeLegacyE2EEObjectStores(request.result);
      ensureE2EEObjectStores(request.result);
    };
  });

  return dbPromise;
}
