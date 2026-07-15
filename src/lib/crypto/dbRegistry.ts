/**
 * dbRegistry — hardened singletons for every IndexedDB the E2EE stack uses.
 *
 * Same Safari/iOS-safe pattern as `indexedDb.ts` (the E2EE singleton):
 *   - one connection per DB, reused across the app;
 *   - `db.close()` neutralized so feature code can never wedge concurrent
 *     transactions ("database connection is closing");
 *   - `onversionchange` / `onclose` / `onerror` invalidate the singleton so
 *     the next caller transparently reopens.
 *
 * `runTxOn(dbKey, ...)` in `indexedDbTx.ts` consumes these openers.
 *
 * If you add a new IndexedDB, register it here — never call `indexedDB.open`
 * directly elsewhere.
 */

import { hardGlobals } from './cryptoIntegrity';

export type DBKey =
  | 'e2ee-keys'              // src/lib/crypto/indexedDb.ts (handled separately)
  | 'ratchet'                // forsure-ratchet
  | 'device-sessions'        // forsure-device-sessions
  | 'spk'                    // forsure-spk
  | 'prekeys'                // forsure-prekeys (legacy backup-only)
  | 'x3dh-replay'            // forsure-x3dh-replay
  | 'skipped-wrap'           // forsure-crypto-skipped-wrap
  | 'pin-wrap'               // forsure-pin-wrap
  | 'plaintext-cache'        // forsure-plaintext-cache
  | 'msg-queue';             // forsure-msg-queue (strictly device-local)

interface DBSpec {
  name: string;
  version: number;
  stores: Array<{
    name: string;
    keyPath?: string;
    indexes?: Array<{ name: string; keyPath: string | string[]; options?: IDBIndexParameters }>;
  }>;
}

const SPECS: Record<Exclude<DBKey, 'e2ee-keys'>, DBSpec> = {
  ratchet: {
    name: 'forsure-ratchet',
    version: 1,
    stores: [{ name: 'ratchet-states', keyPath: 'convId' }],
  },
  'device-sessions': {
    name: 'forsure-device-sessions',
    version: 3,
    stores: [
      { name: 'sessions', keyPath: 'id' },
      {
        name: 'initiating-sessions',
        keyPath: 'id',
        indexes: [
          { name: 'by-session-id', keyPath: 'sessionId', options: { unique: false } },
          { name: 'by-expiry', keyPath: 'expiresAt', options: { unique: false } },
        ],
      },
    ],
  },
  spk: {
    name: 'forsure-spk',
    version: 2,
    stores: [{ name: 'signed-prekeys', keyPath: 'id' }],
  },
  prekeys: {
    name: 'forsure-prekeys',
    version: 1,
    stores: [{ name: 'private-prekeys', keyPath: 'id' }],
  },
  'x3dh-replay': {
    name: 'forsure-x3dh-replay',
    version: 1,
    stores: [{ name: 'consumed-initials', keyPath: 'id' }],
  },
  'skipped-wrap': {
    name: 'forsure-crypto-skipped-wrap',
    version: 1,
    stores: [{ name: 'wrap-keys' }],
  },
  'pin-wrap': {
    name: 'forsure-pin-wrap',
    version: 2,
    stores: [
      { name: 'pin-wrapped-keys', keyPath: 'id' },
      { name: 'wrapped-keys', keyPath: 'id' },
    ],
  },
  'plaintext-cache': {
    name: 'forsure-plaintext-cache',
    version: 1,
    stores: [
      { name: 'messages', keyPath: 'id' },
      { name: 'device-keys', keyPath: 'id' },
    ],
  },
  'msg-queue': {
    name: 'forsure-msg-queue',
    version: 2,
    stores: [
      {
        name: 'outbound',
        keyPath: 'localId',
        indexes: [
          { name: 'conversationId', keyPath: 'conversationId' },
          { name: 'status', keyPath: 'status' },
          { name: 'by-user-conversation', keyPath: ['userId', 'conversationId'] },
          { name: 'by-updated-at', keyPath: 'updatedAt' },
        ],
      },
      {
        name: 'device-keys',
        keyPath: 'id',
      },
    ],
  },
};

const promises = new Map<DBKey, Promise<IDBDatabase>>();

function reset(key: DBKey) {
  promises.delete(key);
}

function ensureStores(db: IDBDatabase, spec: DBSpec, upgradeTx?: IDBTransaction | null) {
  for (const storeSpec of spec.stores) {
    let store: IDBObjectStore;
    if (!db.objectStoreNames.contains(storeSpec.name)) {
      store = db.createObjectStore(
        storeSpec.name,
        storeSpec.keyPath ? { keyPath: storeSpec.keyPath } : undefined,
      );
    } else {
      if (!upgradeTx) continue;
      store = upgradeTx.objectStore(storeSpec.name);
    }

    for (const index of storeSpec.indexes ?? []) {
      if (!store.indexNames.contains(index.name)) {
        store.createIndex(index.name, index.keyPath, index.options);
      }
    }
  }
}

export function openDB(key: Exclude<DBKey, 'e2ee-keys'>): Promise<IDBDatabase> {
  const cached = promises.get(key);
  if (cached) return cached;
  const spec = SPECS[key];

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = hardGlobals.idbOpen(spec.name, spec.version);

    request.onerror = () => {
      reset(key);
      reject(request.error);
    };
    request.onblocked = () => {
      reset(key);
      reject(new Error(`IndexedDB open blocked: ${spec.name}`));
    };
    request.onupgradeneeded = () => ensureStores(request.result, spec, request.transaction);
    request.onsuccess = () => {
      const db = request.result;
      const closeForUpgrade = db.close.bind(db);
      try {
        Object.defineProperty(db, 'close', {
          configurable: true,
          value: () => console.warn(`[E2EE][IDB:${spec.name}] ignored close()`),
        });
      } catch {}
      db.onversionchange = () => {
        closeForUpgrade();
        reset(key);
      };
      db.onclose = () => reset(key);
      db.onerror = () => reset(key);
      resolve(db);
    };
  });

  promises.set(key, promise);
  return promise;
}

export function reopenDB(key: Exclude<DBKey, 'e2ee-keys'>): Promise<IDBDatabase> {
  reset(key);
  return openDB(key);
}

export function __resetRegistryForTests(): void {
  promises.clear();
}
