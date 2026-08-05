import { hardCrypto } from './cryptoIntegrity';

const DB_NAME = 'forsure-ace-web';
const DB_VERSION = 1;
const ANCHOR_STORE = 'anchors';
const SECRET_STORE = 'secrets';
const ANCHOR_ID = 'aegis-web-anchor-v1';
const FORMAT_VERSION = 1;
const PROBE_KEY = '__aegis_web_enclave_probe__';
const TRANSIENT_BACKOFF_MS = [50, 150, 400] as const;

type TxMode = 'readonly' | 'readwrite';

interface WebEnclaveAnchorRecord {
  id: string;
  key: CryptoKey;
  createdAt: number;
}

interface WebEnclaveSecretRecord {
  id: string;
  version: number;
  revision: number;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  createdAt: number;
  updatedAt: number;
}

export class WebAegisEnclaveUnavailableError extends Error {
  constructor(reason: string) {
    super(`E2EE_WEB_ENCLAVE_UNAVAILABLE:${reason}`);
    this.name = 'WebAegisEnclaveUnavailableError';
  }
}

export class WebAegisEnclaveAnchorMissingError extends Error {
  constructor() {
    super('E2EE_WEB_ENCLAVE_ANCHOR_MISSING');
    this.name = 'WebAegisEnclaveAnchorMissingError';
  }
}

export class WebAegisEnclaveIntegrityError extends Error {
  constructor(key: string, cause?: unknown) {
    super(`E2EE_WEB_ENCLAVE_INTEGRITY_FAILED:${key}`);
    this.name = 'WebAegisEnclaveIntegrityError';
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
    }
  }
}

export interface WebAegisEnclaveHealth {
  available: boolean;
  roundTripOk: boolean;
  anchorPresent: boolean;
  persistentStorage: boolean | null;
  persistenceRequested: boolean;
  warning: string | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let persistenceRequest: Promise<boolean> | null = null;
let writeTail: Promise<void> = Promise.resolve();

function requireBrowserPrimitives(): void {
  if (!globalThis.crypto?.subtle) {
    throw new WebAegisEnclaveUnavailableError('webcrypto');
  }
  if (typeof globalThis.indexedDB === 'undefined') {
    throw new WebAegisEnclaveUnavailableError('indexeddb');
  }
}

function originBinding(): string {
  try {
    const origin = globalThis.location?.origin;
    return origin && origin !== 'null' ? origin : 'opaque-origin';
  } catch {
    return 'opaque-origin';
  }
}

function buildAad(key: string, revision: number): Uint8Array {
  return new TextEncoder().encode(
    `forsure-ace-web|${originBinding()}|${key}|v${FORMAT_VERSION}|r${revision}`,
  );
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function isTransientIndexedDbError(error: unknown): boolean {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'InvalidStateError' || name === 'TransactionInactiveError') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('database connection is closing')
    || message.includes('transaction has finished');
}

function openWebEnclaveDb(): Promise<IDBDatabase> {
  requireBrowserPrimitives();
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new WebAegisEnclaveUnavailableError('indexeddb_blocked'));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ANCHOR_STORE)) {
        db.createObjectStore(ANCHOR_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SECRET_STORE)) {
        db.createObjectStore(SECRET_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => { dbPromise = null; };
      db.onerror = () => { dbPromise = null; };
      resolve(db);
    };
  });

  return dbPromise;
}

async function runTransaction<T>(
  stores: string[],
  mode: TxMode,
  operation: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_BACKOFF_MS.length; attempt += 1) {
    try {
      const db = await openWebEnclaveDb();
      const tx = db.transaction(stores, mode);
      const completed = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
      });
      const result = await operation(tx);
      await completed;
      return result;
    } catch (error) {
      lastError = error;
      if (!isTransientIndexedDbError(error) || attempt === TRANSIENT_BACKOFF_MS.length) {
        throw error;
      }
      dbPromise = null;
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_BACKOFF_MS[attempt]));
    }
  }
  throw lastError;
}

function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const run = writeTail.then(operation, operation);
  writeTail = run.then(() => undefined, () => undefined);
  return run;
}

async function readAnchor(): Promise<WebEnclaveAnchorRecord | undefined> {
  return runTransaction([ANCHOR_STORE], 'readonly', (tx) =>
    requestToPromise<WebEnclaveAnchorRecord | undefined>(
      tx.objectStore(ANCHOR_STORE).get(ANCHOR_ID),
    ),
  );
}

async function readSecret(key: string): Promise<WebEnclaveSecretRecord | undefined> {
  return runTransaction([SECRET_STORE], 'readonly', (tx) =>
    requestToPromise<WebEnclaveSecretRecord | undefined>(
      tx.objectStore(SECRET_STORE).get(key),
    ),
  );
}

async function hasAnySecret(): Promise<boolean> {
  const count = await runTransaction([SECRET_STORE], 'readonly', (tx) =>
    requestToPromise<number>(tx.objectStore(SECRET_STORE).count()),
  );
  return count > 0;
}

async function createAnchor(): Promise<WebEnclaveAnchorRecord> {
  requireBrowserPrimitives();
  const key = await hardCrypto.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  ) as CryptoKey;
  const record: WebEnclaveAnchorRecord = {
    id: ANCHOR_ID,
    key,
    createdAt: Date.now(),
  };

  try {
    await runTransaction([ANCHOR_STORE], 'readwrite', (tx) =>
      requestToPromise(tx.objectStore(ANCHOR_STORE).add(record)),
    );
    return record;
  } catch (error) {
    const name = error instanceof DOMException ? error.name : '';
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (name !== 'ConstraintError' && !message.includes('ConstraintError')) throw error;
    const raced = await readAnchor();
    if (!raced) throw error;
    return raced;
  }
}

async function requireAnchorForExistingData(): Promise<WebEnclaveAnchorRecord> {
  const anchor = await readAnchor();
  if (anchor) return anchor;
  if (await hasAnySecret()) throw new WebAegisEnclaveAnchorMissingError();
  return createAnchor();
}

async function requestPersistentStorage(): Promise<boolean> {
  if (persistenceRequest) return persistenceRequest;
  persistenceRequest = (async () => {
    try {
      const storage = globalThis.navigator?.storage;
      if (!storage?.persist) return false;
      if (storage.persisted && await storage.persisted()) return true;
      return await storage.persist();
    } catch {
      return false;
    }
  })();
  return persistenceRequest;
}

export async function webAegisEnclaveGet(key: string): Promise<string | null> {
  requireBrowserPrimitives();
  const record = await readSecret(key);
  if (!record) return null;
  if (record.version !== FORMAT_VERSION || !Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw new WebAegisEnclaveIntegrityError(key);
  }

  const anchor = await readAnchor();
  if (!anchor) throw new WebAegisEnclaveAnchorMissingError();

  try {
    const plaintext = await hardCrypto.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(record.iv),
        additionalData: buildAad(key, record.revision),
        tagLength: 128,
      },
      anchor.key,
      record.ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    throw new WebAegisEnclaveIntegrityError(key, error);
  }
}

export async function webAegisEnclaveSet(key: string, value: string): Promise<void> {
  requireBrowserPrimitives();
  void requestPersistentStorage();
  const anchor = await requireAnchorForExistingData();

  await enqueueWrite(async () => {
    const current = await readSecret(key);
    const revision = (current?.revision ?? 0) + 1;
    const iv = hardCrypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await hardCrypto.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: buildAad(key, revision),
        tagLength: 128,
      },
      anchor.key,
      new TextEncoder().encode(value),
    );
    const now = Date.now();
    const record: WebEnclaveSecretRecord = {
      id: key,
      version: FORMAT_VERSION,
      revision,
      iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength),
      ciphertext,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };

    await runTransaction([SECRET_STORE], 'readwrite', (tx) =>
      requestToPromise(tx.objectStore(SECRET_STORE).put(record)),
    );
  });

  const readback = await webAegisEnclaveGet(key);
  if (readback !== value) throw new WebAegisEnclaveIntegrityError(key);
}

export async function webAegisEnclaveRemove(key: string): Promise<void> {
  requireBrowserPrimitives();
  await enqueueWrite(() => runTransaction([SECRET_STORE], 'readwrite', (tx) =>
    requestToPromise(tx.objectStore(SECRET_STORE).delete(key)),
  ));
  if (await readSecret(key)) throw new WebAegisEnclaveIntegrityError(key);
}

export async function verifyWebAegisEnclaveHealth(): Promise<WebAegisEnclaveHealth> {
  try {
    requireBrowserPrimitives();
    const value = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await webAegisEnclaveSet(PROBE_KEY, value);
    const roundTripOk = await webAegisEnclaveGet(PROBE_KEY) === value;
    await webAegisEnclaveRemove(PROBE_KEY);

    let persistentStorage: boolean | null = null;
    try {
      persistentStorage = globalThis.navigator?.storage?.persisted
        ? await globalThis.navigator.storage.persisted()
        : null;
    } catch {
      persistentStorage = null;
    }

    return {
      available: true,
      roundTripOk,
      anchorPresent: Boolean(await readAnchor()),
      persistentStorage,
      persistenceRequested: Boolean(persistenceRequest),
      warning: roundTripOk ? null : 'web enclave round-trip mismatch',
    };
  } catch (error) {
    return {
      available: false,
      roundTripOk: false,
      anchorPresent: false,
      persistentStorage: null,
      persistenceRequested: Boolean(persistenceRequest),
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}
