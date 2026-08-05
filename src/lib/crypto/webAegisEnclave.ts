import { hardCrypto } from './cryptoIntegrity';
import { reqToPromise, runTxOn } from './indexedDbTx';

const DB_KEY = 'web-enclave' as const;
const ANCHOR_STORE = 'anchors';
const SECRET_STORE = 'secrets';
const ANCHOR_ID = 'aegis-web-anchor-v1';
const FORMAT_VERSION = 1;
const PROBE_KEY = '__aegis_web_enclave_probe__';

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

let persistenceRequest: Promise<boolean> | null = null;

function requireWebCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new WebAegisEnclaveUnavailableError('webcrypto');
  if (typeof globalThis.indexedDB === 'undefined') {
    throw new WebAegisEnclaveUnavailableError('indexeddb');
  }
  return subtle;
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

async function readAnchor(): Promise<WebEnclaveAnchorRecord | undefined> {
  return runTxOn(DB_KEY, [ANCHOR_STORE], 'readonly', (tx) =>
    reqToPromise<WebEnclaveAnchorRecord | undefined>(
      tx.objectStore(ANCHOR_STORE).get(ANCHOR_ID),
    ),
  );
}

async function readSecret(key: string): Promise<WebEnclaveSecretRecord | undefined> {
  return runTxOn(DB_KEY, [SECRET_STORE], 'readonly', (tx) =>
    reqToPromise<WebEnclaveSecretRecord | undefined>(
      tx.objectStore(SECRET_STORE).get(key),
    ),
  );
}

async function hasAnySecret(): Promise<boolean> {
  const count = await runTxOn(DB_KEY, [SECRET_STORE], 'readonly', (tx) =>
    reqToPromise<number>(tx.objectStore(SECRET_STORE).count()),
  );
  return count > 0;
}

async function createAnchor(): Promise<WebEnclaveAnchorRecord> {
  requireWebCrypto();
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
    await runTxOn(DB_KEY, [ANCHOR_STORE], 'readwrite', (tx) =>
      reqToPromise(tx.objectStore(ANCHOR_STORE).add(record)),
    );
    return record;
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'ConstraintError') throw error;
    const raced = await readAnchor();
    if (!raced) throw error;
    return raced;
  }
}

async function requireAnchorForExistingData(): Promise<WebEnclaveAnchorRecord> {
  requireWebCrypto();
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
  requireWebCrypto();
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
  requireWebCrypto();
  void requestPersistentStorage();

  const [anchor, current] = await Promise.all([
    requireAnchorForExistingData(),
    readSecret(key),
  ]);
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

  await runTxOn(DB_KEY, [SECRET_STORE], 'readwrite', (tx) =>
    reqToPromise(tx.objectStore(SECRET_STORE).put(record)),
  );

  const readback = await webAegisEnclaveGet(key);
  if (readback !== value) throw new WebAegisEnclaveIntegrityError(key);
}

export async function webAegisEnclaveRemove(key: string): Promise<void> {
  requireWebCrypto();
  await runTxOn(DB_KEY, [SECRET_STORE], 'readwrite', (tx) =>
    reqToPromise(tx.objectStore(SECRET_STORE).delete(key)),
  );
  if (await readSecret(key)) throw new WebAegisEnclaveIntegrityError(key);
}

export async function verifyWebAegisEnclaveHealth(): Promise<WebAegisEnclaveHealth> {
  try {
    requireWebCrypto();
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
