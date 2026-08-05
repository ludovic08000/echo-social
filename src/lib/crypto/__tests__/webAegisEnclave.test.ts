import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WebAegisEnclaveAnchorMissingError,
  WebAegisEnclaveIntegrityError,
  verifyWebAegisEnclaveHealth,
  webAegisEnclaveGet,
  webAegisEnclaveRemove,
  webAegisEnclaveSet,
} from '../webAegisEnclave';

const DB_NAME = 'forsure-ace-web';
const DB_VERSION = 1;
const ANCHOR_STORE = 'anchors';
const SECRET_STORE = 'secrets';
const ANCHOR_ID = 'aegis-web-anchor-v1';

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
  afterEach(clearEnclave);

  it('round-trips critical material in Chrome-compatible IndexedDB storage', async () => {
    await webAegisEnclaveSet('identity', 'private-jwk-bundle');
    expect(await webAegisEnclaveGet('identity')).toBe('private-jwk-bundle');

    await webAegisEnclaveRemove('identity');
    expect(await webAegisEnclaveGet('identity')).toBeNull();
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

  it('reports a successful authenticated health probe', async () => {
    const health = await verifyWebAegisEnclaveHealth();
    expect(health.available).toBe(true);
    expect(health.roundTripOk).toBe(true);
    expect(health.anchorPresent).toBe(true);
  });
});
