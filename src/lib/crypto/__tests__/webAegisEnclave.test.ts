import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WebAegisEnclaveAnchorMissingError,
  WebAegisEnclaveIntegrityError,
  verifyWebAegisEnclaveHealth,
  webAegisEnclaveGet,
  webAegisEnclaveRemove,
  webAegisEnclaveSet,
  resolveWebAegisLogicalIdentity,
} from '../webAegisEnclave';

const DB_NAME = 'forsure-ace-web';
const DB_VERSION = 1;
const ANCHOR_STORE = 'anchors';
const SECRET_STORE = 'secrets';
const ANCHOR_ID = 'aegis-web-anchor-v1';
const WRITE_LOCK_NAME = 'forsure-ace-web-write-v1';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ANCHOR_STORE)) {
        db.createObjectStore(ANCHOR_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SECRET_STORE)) {
        db.createObjectStore(SECRET_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function mutate(
  stores: string[],
  operation: (tx: IDBTransaction) => Promise<unknown>,
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(stores, 'readwrite');
  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  await operation(tx);
  await completed;
  db.close();
}

async function clearEnclave(): Promise<void> {
  await mutate([ANCHOR_STORE, SECRET_STORE], async (tx) => {
    await Promise.all([
      requestToPromise(tx.objectStore(ANCHOR_STORE).clear()),
      requestToPromise(tx.objectStore(SECRET_STORE).clear()),
    ]);
  });
}

describe('ACE Web', () => {
  beforeEach(clearEnclave);
  afterEach(async () => {
    Reflect.deleteProperty(globalThis.navigator, 'locks');
    await clearEnclave();
  });

  it('round-trips critical material in Chrome-compatible IndexedDB storage', async () => {
    await webAegisEnclaveSet('identity', 'private-jwk-bundle');
    expect(await webAegisEnclaveGet('identity')).toBe('private-jwk-bundle');

    await webAegisEnclaveRemove('identity');
    expect(await webAegisEnclaveGet('identity')).toBeNull();
  });

  it('separates the production enclave from Lovable and preview environments', () => {
    expect(resolveWebAegisLogicalIdentity('forsure.fans').environmentId).toBe('prod');
    expect(resolveWebAegisLogicalIdentity('www.forsure.fans').environmentId).toBe('prod');
    expect(resolveWebAegisLogicalIdentity('calm-connect-05.lovable.app').environmentId).toBe('dev');
    expect(resolveWebAegisLogicalIdentity('id-preview--example.lovable.app').environmentId).toBe('dev');
  });

  it('keeps the AES anchor non-extractable', async () => {
    await webAegisEnclaveSet('device-key', 'sealed-device-key');
    const db = await openDb();
    const tx = db.transaction(ANCHOR_STORE, 'readonly');
    const anchor = await requestToPromise<{ key: CryptoKey }>(
      tx.objectStore(ANCHOR_STORE).get(ANCHOR_ID),
    );
    db.close();

    expect(anchor.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', anchor.key)).rejects.toBeTruthy();
  });

  it('rejects ciphertext modified inside IndexedDB', async () => {
    const key = 'tamper-test';
    await webAegisEnclaveSet(key, 'authenticated-value');

    await mutate([SECRET_STORE], async (tx) => {
      const store = tx.objectStore(SECRET_STORE);
      const record = await requestToPromise<{
        id: string;
        ciphertext: ArrayBuffer;
      }>(store.get(key));
      const bytes = new Uint8Array(record.ciphertext.slice(0));
      bytes[0] ^= 0xff;
      await requestToPromise(store.put({ ...record, ciphertext: bytes.buffer }));
    });

    await expect(webAegisEnclaveGet(key)).rejects.toBeInstanceOf(
      WebAegisEnclaveIntegrityError,
    );
  });

  it('fails closed when sealed records survive but their anchor is missing', async () => {
    const key = 'anchor-loss-test';
    await webAegisEnclaveSet(key, 'continuity-value');
    await mutate([ANCHOR_STORE], async (tx) => {
      await requestToPromise(tx.objectStore(ANCHOR_STORE).delete(ANCHOR_ID));
    });

    await expect(webAegisEnclaveGet(key)).rejects.toBeInstanceOf(
      WebAegisEnclaveAnchorMissingError,
    );
  });

  it('serializes concurrent writes with the Web Locks API when available', async () => {
    let lockTail = Promise.resolve();
    let activeLocks = 0;
    let maxActiveLocks = 0;

    const request = vi.fn((
      name: string,
      options: { mode?: string },
      callback: (lock: Lock | null) => Promise<unknown>,
    ) => {
      const run = lockTail.then(async () => {
        activeLocks += 1;
        maxActiveLocks = Math.max(maxActiveLocks, activeLocks);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return await callback({ name, mode: 'exclusive' } as Lock);
        } finally {
          activeLocks -= 1;
        }
      });
      lockTail = run.then(() => undefined, () => undefined);
      return run;
    });

    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: { request },
    });

    await Promise.all([
      webAegisEnclaveSet('shared-key', 'first'),
      webAegisEnclaveSet('shared-key', 'second'),
    ]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      WRITE_LOCK_NAME,
      { mode: 'exclusive' },
      expect.any(Function),
    );
    expect(maxActiveLocks).toBe(1);
    expect(await webAegisEnclaveGet('shared-key')).toBe('second');
  });

  it('reports a successful authenticated health probe', async () => {
    const health = await verifyWebAegisEnclaveHealth();
    expect(health.available).toBe(true);
    expect(health.roundTripOk).toBe(true);
    expect(health.anchorPresent).toBe(true);
  });

  it('fails closed when a protected browser primitive is replaced', async () => {
    const OriginalTextEncoder = globalThis.TextEncoder;
    class PatchedTextEncoder extends OriginalTextEncoder {}

    Object.defineProperty(globalThis, 'TextEncoder', {
      configurable: true,
      writable: true,
      value: PatchedTextEncoder,
    });

    try {
      await expect(webAegisEnclaveGet('integrity-guard')).rejects.toThrow(
        'E2EE_WEB_ENCLAVE_UNAVAILABLE:crypto_integrity_failed',
      );
    } finally {
      Object.defineProperty(globalThis, 'TextEncoder', {
        configurable: true,
        writable: true,
        value: OriginalTextEncoder,
      });
    }
  });
});
