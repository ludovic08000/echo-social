import { DB_NAME as E2EE_DB_NAME, DB_VERSION as E2EE_DB_VERSION, STORE_KEYS, STORE_PREKEYS, STORE_SESSION } from './constants';
import { hardGlobals } from './cryptoIntegrity';

export type DbKey =
  | 'e2ee'
  | 'ratchet'
  | 'msg-queue'
  | 'device-sessions'
  | 'pin-wrap'
  | 'plaintext-cache'
  | 'prekeys'
  | 'spk';

interface DbConfig {
  name: string;
  version: number;
  expectedStores: string[];
  upgrade: (db: IDBDatabase, tx: IDBTransaction | null) => void;
  needsUpgrade?: (db: IDBDatabase) => boolean | Promise<boolean>;
}

const configs: Record<DbKey, DbConfig> = {
  e2ee: {
    name: E2EE_DB_NAME,
    version: E2EE_DB_VERSION,
    expectedStores: [STORE_KEYS, STORE_SESSION, STORE_PREKEYS],
    upgrade: (db) => {
      if (!db.objectStoreNames.contains(STORE_KEYS)) {
        db.createObjectStore(STORE_KEYS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_SESSION)) {
        db.createObjectStore(STORE_SESSION, { keyPath: 'conversationId' });
      }
      if (!db.objectStoreNames.contains(STORE_PREKEYS)) {
        db.createObjectStore(STORE_PREKEYS, { keyPath: 'id' });
      }
    },
  },
  ratchet: {
    name: 'forsure-ratchet',
    version: 1,
    expectedStores: ['ratchet-states'],
    upgrade: (db) => {
      if (!db.objectStoreNames.contains('ratchet-states')) {
        db.createObjectStore('ratchet-states', { keyPath: 'convId' });
      }
    },
  },
  'msg-queue': {
    name: 'forsure-msg-queue',
    version: 1,
    expectedStores: ['outbound'],
    upgrade: (db, tx) => {
      const store = db.objectStoreNames.contains('outbound')
        ? tx?.objectStore('outbound')
        : db.createObjectStore('outbound', { keyPath: 'localId' });

      if (store && !store.indexNames.contains('conversationId')) {
        store.createIndex('conversationId', 'conversationId', { unique: false });
      }
      if (store && !store.indexNames.contains('status')) {
        store.createIndex('status', 'status', { unique: false });
      }
    },
    needsUpgrade: async (db) => {
      if (!db.objectStoreNames.contains('outbound')) return true;
      return await new Promise<boolean>((resolve) => {
        try {
          const tx = db.transaction('outbound', 'readonly');
          const store = tx.objectStore('outbound');
          resolve(!store.indexNames.contains('conversationId') || !store.indexNames.contains('status'));
        } catch {
          resolve(true);
        }
      });
    },
  },
  'device-sessions': {
    name: 'forsure-device-sessions',
    version: 2,
    expectedStores: ['sessions'],
    upgrade: (db) => {
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
    },
  },
  'pin-wrap': {
    name: 'forsure-pin-wrap',
    version: 2,
    expectedStores: ['pin-wrapped-keys', 'wrapped-keys'],
    upgrade: (db) => {
      if (!db.objectStoreNames.contains('pin-wrapped-keys')) {
        db.createObjectStore('pin-wrapped-keys', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('wrapped-keys')) {
        db.createObjectStore('wrapped-keys', { keyPath: 'id' });
      }
    },
  },
  'plaintext-cache': {
    name: 'forsure-plaintext-cache',
    version: 1,
    expectedStores: ['messages', 'device-keys'],
    upgrade: (db) => {
      if (!db.objectStoreNames.contains('messages')) {
        db.createObjectStore('messages', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('device-keys')) {
        db.createObjectStore('device-keys', { keyPath: 'id' });
      }
    },
  },
  prekeys: {
    name: 'forsure-prekeys',
    version: 1,
    expectedStores: ['private-prekeys'],
    upgrade: (db) => {
      if (!db.objectStoreNames.contains('private-prekeys')) {
        db.createObjectStore('private-prekeys', { keyPath: 'id' });
      }
    },
  },
  spk: {
    name: 'forsure-spk',
    version: 1,
    expectedStores: ['signed-prekeys'],
    upgrade: (db) => {
      if (!db.objectStoreNames.contains('signed-prekeys')) {
        db.createObjectStore('signed-prekeys', { keyPath: 'id' });
      }
    },
  },
};

const dbPromises = new Map<DbKey, Promise<IDBDatabase>>();
const currentDbs = new Map<DbKey, IDBDatabase>();
const managedDbs = new WeakSet<IDBDatabase>();
const originalCloseByDb = new WeakMap<IDBDatabase, () => void>();

function isVersionError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'VersionError';
}

function hasExpectedStores(db: IDBDatabase, config: DbConfig): boolean {
  return config.expectedStores.every((storeName) => db.objectStoreNames.contains(storeName));
}

function closeManagedDb(key: DbKey, db: IDBDatabase, resetPromise: boolean): void {
  if (currentDbs.get(key) === db) {
    currentDbs.delete(key);
  }
  if (resetPromise) {
    dbPromises.delete(key);
  }

  const close = originalCloseByDb.get(db) ?? db.close.bind(db);
  close();
}

function manageDb(key: DbKey, db: IDBDatabase): IDBDatabase {
  currentDbs.set(key, db);
  if (managedDbs.has(db)) return db;

  managedDbs.add(db);
  const originalClose = db.close.bind(db);
  originalCloseByDb.set(db, originalClose);

  try {
    Object.defineProperty(db, 'close', {
      configurable: true,
      value: () => closeManagedDb(key, db, true),
    });
  } catch {
    // Some IndexedDB shims expose close as non-configurable. The registry still
    // resets through onversionchange and retry paths.
  }

  db.onversionchange = () => {
    try {
      closeManagedDb(key, db, true);
    } catch {}
  };

  return db;
}

function openConfiguredDb(key: DbKey, version?: number): Promise<IDBDatabase> {
  const config = configs[key];

  return new Promise((resolve, reject) => {
    const req = version === undefined
      ? hardGlobals.idbOpen(config.name)
      : hardGlobals.idbOpen(config.name, version);

    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(`${config.name} open blocked`));
    req.onsuccess = () => resolve(manageDb(key, req.result));
    req.onupgradeneeded = () => {
      config.upgrade(req.result, req.transaction);
    };
  });
}

async function openWithRepair(key: DbKey): Promise<IDBDatabase> {
  const config = configs[key];
  let db: IDBDatabase;

  try {
    db = await openConfiguredDb(key, config.version);
  } catch (error) {
    if (!isVersionError(error)) throw error;
    db = await openConfiguredDb(key);
  }

  const needsUpgrade = !hasExpectedStores(db, config) || Boolean(await config.needsUpgrade?.(db));
  if (!needsUpgrade) return db;

  const nextVersion = Math.max(db.version + 1, config.version + 1);
  closeManagedDb(key, db, false);
  return openConfiguredDb(key, nextVersion);
}

export function getDbConfig(key: DbKey): Pick<DbConfig, 'name' | 'version'> {
  const { name, version } = configs[key];
  return { name, version };
}

export function resetDb(key: DbKey): void {
  dbPromises.delete(key);
  const db = currentDbs.get(key);
  if (db) {
    try {
      closeManagedDb(key, db, false);
    } catch {}
  }
}

export async function getDb(key: DbKey): Promise<IDBDatabase> {
  const existing = dbPromises.get(key);
  if (existing) return existing;

  const promise = openWithRepair(key).catch((error) => {
    dbPromises.delete(key);
    throw error;
  });
  dbPromises.set(key, promise);
  return promise;
}
