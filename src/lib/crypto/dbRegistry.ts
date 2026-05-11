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
  | 'x3dh-replay'            // forsure-x3dh-replay
  | 'skipped-wrap'           // forsure-crypto-skipped-wrap
  | 'pin-wrap'               // forsure-pin-wrap
  | 'plaintext-cache'        // forsure-plaintext-cache
  | 'msg-queue';             // forsure-msg-queue

interface DBSpec {
  name: string;
  version: number;
  stores: Array<{
    name: string;
    keyPath?: string;
    indexes?: Array<{ name: string; keyPath: string; options?: IDBIndexParameters }>;
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
    version: 2,
    stores: [{ name: 'sessions', keyPath: 'id' }],
  },
  spk: {
    name: 'forsure-spk',
    version: 2,
    stores: [{ name: 'signed-prekeys', keyPath: 'id' }],
  },
  'x3dh-replay': {
    name: 'forsure-x3dh-replay',
    version: 1,
    stores: [{ name: 'consumed-initials', keyPath: 'id' }],
  },
  'skipped-wrap': {
    name: 'forsure-crypto-skipped-wrap',
    version: 1,
    // No keyPath: manual keys.
    stores: [{ name: 'wrap-keys' }],
  },
  'pin-wrap': {
    name: 'forsure-pin-wrap',
    version: 2,
    stores: [
      { name: 'pin-wrapped-keys', keyPath: 'id' },
      { name: 'wrapped-keys', keyPath: 'id' }, // legacy migration store
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
    version: 1,
    stores: [
      {
        name: 'outbound',
        keyPath: 'localId',
        indexes: [{ name: 'conversationId', keyPath: 'conversationId' }],
      },
    ],
  },
};

const promises = new Map<DBKey, Promise<IDBDatabase>>();

function reset(key: DBKey) {
  promises.delete(key);
}

function ensureStores(db: IDBDatabase, spec: DBSpec) {
  for (const s of spec.stores) {
    if (!db.objectStoreNames.contains(s.name)) {
      const store = db.createObjectStore(
        s.name,
        s.keyPath ? { keyPath: s.keyPath } : undefined,
      );
      for (const idx of s.indexes ?? []) {
        store.createIndex(idx.name, idx.keyPath, idx.options);
      }
    } else if (s.indexes) {
      // Add missing indexes during upgrade transactions.
      const tx = db.transaction(s.name);
      // No-op outside upgrade context; indexes added inside onupgradeneeded only.
    }
  }
}

export function openDB(key: Exclude<DBKey, 'e2ee-keys'>): Promise<IDBDatabase> {
  const cached = promises.get(key);
  if (cached) return cached;
  const spec = SPECS[key];

  const p = new Promise<IDBDatabase>((resolve, reject) => {
    const req = hardGlobals.idbOpen(spec.name, spec.version);

    req.onerror = () => {
      reset(key);
      reject(req.error);
    };
    req.onblocked = () => {
      reset(key);
      reject(new Error(`IndexedDB open blocked: ${spec.name}`));
    };
    req.onupgradeneeded = () => ensureStores(req.result, spec);
    req.onsuccess = () => {
      const db = req.result;
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

  promises.set(key, p);
  return p;
}

export function reopenDB(key: Exclude<DBKey, 'e2ee-keys'>): Promise<IDBDatabase> {
  reset(key);
  return openDB(key);
}

/** TEST helper. */
export function __resetRegistryForTests(): void {
  promises.clear();
}
