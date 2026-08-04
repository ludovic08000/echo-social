/**
 * Coffre local des clés sautées (Double Ratchet).
 *
 * Invariant corrigé : une clé de message sautée ne doit jamais rester en clair
 * dans IndexedDB. Elle est scellée par une SWK (Skipped-key Wrapping Key)
 * AES-GCM 256 non exportable, générée une seule fois par appareil et stockée
 * comme CryptoKey (le matériel brut ne quitte jamais le moteur crypto).
 *
 * Ce scellement est purement local : il ne touche pas le format wire.
 */

import { hardCrypto } from './cryptoIntegrity';
import { bufferToBase64, base64ToBuffer, randomBytes } from './utils';
import { runTxOn, reqToPromise } from './indexedDbTx';

const DB_KEY = 'skipped-wrap' as const;
const STORE = 'wrap-keys';
const RECORD_ID = 'swk-v1';

let cached: CryptoKey | null = null;
let inflight: Promise<CryptoKey> | null = null;

async function loadOrCreateSwk(): Promise<CryptoKey> {
  const existing = await runTxOn(DB_KEY, [STORE], 'readonly', (tx) =>
    reqToPromise<CryptoKey | undefined>(tx.objectStore(STORE).get(RECORD_ID)),
  ).catch(() => undefined);

  if (existing && typeof (existing as CryptoKey).type === 'string') {
    return existing as CryptoKey;
  }

  // Clé non exportable : impossible à exfiltrer même si IndexedDB est lu.
  const key = await hardCrypto.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  ) as CryptoKey;

  await runTxOn(DB_KEY, [STORE], 'readwrite', (tx) =>
    reqToPromise(tx.objectStore(STORE).put(key, RECORD_ID)),
  );
  return key;
}

export async function getSkippedWrapKey(): Promise<CryptoKey> {
  if (cached) return cached;
  if (!inflight) {
    inflight = loadOrCreateSwk()
      .then((k) => {
        cached = k;
        return k;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export interface WrappedSkippedKey {
  /** clé de message scellée, base64 */
  wrapB64: string;
  /** IV AES-GCM 12 octets, base64 */
  wrapIvB64: string;
}

export async function wrapSkippedKey(mkB64: string): Promise<WrappedSkippedKey> {
  const swk = await getSkippedWrapKey();
  const iv = randomBytes(12);
  const ct = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 } as AesGcmParams,
    swk,
    base64ToBuffer(mkB64),
  );
  return { wrapB64: bufferToBase64(ct), wrapIvB64: bufferToBase64(iv.buffer as ArrayBuffer) };
}

export async function unwrapSkippedKey(entry: WrappedSkippedKey): Promise<string> {
  const swk = await getSkippedWrapKey();
  const iv = new Uint8Array(base64ToBuffer(entry.wrapIvB64));
  const pt = await hardCrypto.decrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 } as AesGcmParams,
    swk,
    base64ToBuffer(entry.wrapB64),
  );
  return bufferToBase64(pt);
}

/** Purge la SWK : toutes les clés sautées scellées deviennent indéchiffrables. */
export async function purgeSkippedWrapKey(): Promise<void> {
  cached = null;
  await runTxOn(DB_KEY, [STORE], 'readwrite', (tx) =>
    reqToPromise(tx.objectStore(STORE).delete(RECORD_ID)),
  ).catch(() => undefined);
}
