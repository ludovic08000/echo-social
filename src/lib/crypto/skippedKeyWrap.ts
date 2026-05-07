/**
 * Lot A3 — Skipped Double Ratchet keys at-rest protection.
 *
 * Audit finding: `serializeRatchetState` exported every skipped message key
 * as plain JWK and persisted them in IndexedDB. Anyone reading raw IDB
 * (forensic dump, malicious extension) recovered up to 7 days of historical
 * message keys → retroactive plaintext.
 *
 * Fix: wrap each skipped key with a **non-extractable** AES-GCM 256-bit
 * "skipped-key wrap key" (SWK) that is itself persisted as an opaque
 * CryptoKey handle (Chrome / Safari stores those via the OS keystore;
 * structured clone refuses to export). The SWK is generated on first use
 * and rotated whenever the user clears their crypto material.
 *
 * Wire format (per skipped entry, base64): "v1." + base64(iv || ct)
 *   - iv  = 12 random bytes
 *   - ct  = AES-GCM(SWK, JSON.stringify(jwk), iv)
 *
 * Backward compatibility: legacy entries are plain JWK objects. The
 * deserializer transparently accepts both formats during the migration
 * window and re-wraps on next save.
 */
import { hardCrypto } from './cryptoIntegrity';

const DB_NAME = 'forsure-crypto-skipped-wrap';
const DB_VERSION = 1;
const STORE = 'wrap-keys';
const KEY_ID = 'swk-v1';

let cached: CryptoKey | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const s = t.objectStore(STORE);
        const r = fn(s);
        r.onsuccess = () => resolve(r.result as T);
        r.onerror = () => reject(r.error);
      }),
  );
}

/** Get (or generate + persist) the skipped-key wrap key. */
export async function getSkippedWrapKey(): Promise<CryptoKey> {
  if (cached) return cached;

  const stored = await tx<CryptoKey | undefined>('readonly', (s) => s.get(KEY_ID));
  if (stored && (stored as CryptoKey).type === 'secret') {
    cached = stored as CryptoKey;
    return cached;
  }

  const fresh = await hardCrypto.generateKey(
    { name: 'AES-GCM', length: 256 },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  );
  await tx('readwrite', (s) => s.put(fresh, KEY_ID));
  cached = fresh;
  return fresh;
}

/** Forget the wrap key (e.g. on logout/lock). Re-issued on next use. */
export async function purgeSkippedWrapKey(): Promise<void> {
  cached = null;
  try {
    await tx('readwrite', (s) => s.delete(KEY_ID));
  } catch {
    /* swallow */
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(buf: ArrayBuffer): string {
  let s = '';
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
function b64ToBuf(b: string): Uint8Array {
  const s = atob(b);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

/**
 * Wrap a single skipped key (already exported as JWK) for at-rest storage.
 * Returns a "v1.<base64(iv||ct)>" string that must be passed back to
 * `unwrapSkippedJwk()` on load.
 */
export async function wrapSkippedJwk(jwk: JsonWebKey): Promise<string> {
  const key = await getSkippedWrapKey();
  const iv = hardCrypto.getRandomValues(new Uint8Array(12));
  const ct = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> },
    key,
    enc.encode(JSON.stringify(jwk)),
  );
  const out = new Uint8Array(iv.length + (ct as ArrayBuffer).byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct as ArrayBuffer), iv.length);
  return `v1.${b64(out.buffer)}`;
}

/** Inverse of `wrapSkippedJwk`. Returns null on auth failure. */
export async function unwrapSkippedJwk(wrapped: string): Promise<JsonWebKey | null> {
  if (!wrapped.startsWith('v1.')) return null;
  try {
    const blob = b64ToBuf(wrapped.slice(3));
    const iv = blob.slice(0, 12);
    const ct = blob.slice(12);
    const key = await getSkippedWrapKey();
    const pt = await hardCrypto.decrypt(
      { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> },
      key,
      ct as Uint8Array<ArrayBuffer>,
    );
    return JSON.parse(dec.decode(pt as ArrayBuffer)) as JsonWebKey;
  } catch {
    return null;
  }
}

/**
 * Type guard: detect if an entry is a wrapped string (new) vs a raw JWK
 * object (legacy migration path).
 */
export function isWrappedSkippedEntry(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('v1.');
}
