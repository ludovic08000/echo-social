import { DB_NAME, DB_VERSION, STORE_KEYS, STORE_PREKEYS, STORE_SESSION } from './constants';
import { hardGlobals } from './cryptoIntegrity';

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

export function openE2EEDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = hardGlobals.idbOpen(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      ensureE2EEObjectStores(request.result);
    };
  });
}
