/**
 * PIN Wrap — Encrypt identity keys at rest with PIN-derived key
 * 
 * When active:
 * - Raw JWKs are DELETED from IndexedDB
 * - Only the AES-GCM encrypted blob remains
 * - Key material is only available in memory after PIN entry
 * 
 * Derivation: PBKDF2-SHA256 (600,000 iterations) from 6-digit PIN
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { runTxOn, reqToPromise } from './indexedDbTx';

const PIN_WRAP_STORE = 'pin-wrapped-keys';
const PBKDF2_ITERATIONS = 600_000;

interface WrappedKeyBlob {
  id: string;
  salt: string;       // Base64
  iv: string;          // Base64
  ciphertext: string;  // Base64 (encrypted JWK bundle)
  version: number;
}

function bufToB64(buf: ArrayBuffer): string {
  return hardGlobals.btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = hardGlobals.atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Derive AES-256 wrapping key from PIN */
async function deriveWrappingKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const pinBytes = new hardGlobals.TextEncoder().encode(pin);
  const baseKey = await hardCrypto.importKey('raw', pinBytes, 'PBKDF2', false, ['deriveKey']);
  return hardCrypto.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Wrap (encrypt) identity key JWKs with PIN and store in dedicated DB.
 * After wrapping, the caller should delete raw keys from the main store.
 */
export async function wrapKeysWithPin(
  userId: string,
  pin: string,
  jwkBundle: {
    publicKeyJWK: JsonWebKey;
    privateKeyJWK: JsonWebKey;
    signingPublicKeyJWK: JsonWebKey;
    signingPrivateKeyJWK: JsonWebKey;
    fingerprint: string;
    createdAt: number;
  },
): Promise<void> {
  const salt = hardCrypto.getRandomValues(new Uint8Array(32));
  const iv = hardCrypto.getRandomValues(new Uint8Array(12));
  const wrapKey = await deriveWrappingKey(pin, salt);

  const plaintext = new hardGlobals.TextEncoder().encode(hardGlobals.jsonStringify(jwkBundle));
  const ciphertext = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> },
    wrapKey,
    plaintext,
  );

  const blob: WrappedKeyBlob = {
    id: userId,
    salt: bufToB64(salt.buffer as ArrayBuffer),
    iv: bufToB64(iv.buffer as ArrayBuffer),
    ciphertext: bufToB64(ciphertext),
    version: 1,
  };

  await runTxOn('pin-wrap', [PIN_WRAP_STORE], 'readwrite', (tx) => {
    tx.objectStore(PIN_WRAP_STORE).put(blob);
  });

  console.log('[PIN_WRAP] Keys encrypted and stored');
}

/**
 * Unwrap (decrypt) identity key JWKs using PIN.
 * Returns null if PIN is wrong or no wrapped keys exist.
 */
export async function unwrapKeysWithPin(
  userId: string,
  pin: string,
): Promise<{
  publicKeyJWK: JsonWebKey;
  privateKeyJWK: JsonWebKey;
  signingPublicKeyJWK: JsonWebKey;
  signingPrivateKeyJWK: JsonWebKey;
  fingerprint: string;
  createdAt: number;
} | null> {
  const blob = await runTxOn('pin-wrap', [PIN_WRAP_STORE], 'readonly', (tx) =>
    reqToPromise(tx.objectStore(PIN_WRAP_STORE).get(userId) as IDBRequest<WrappedKeyBlob | undefined>),
  );

  if (!blob) return null;

  try {
    const salt = new Uint8Array(b64ToBuf(blob.salt));
    const iv = new Uint8Array(b64ToBuf(blob.iv));
    const ciphertext = b64ToBuf(blob.ciphertext);
    const wrapKey = await deriveWrappingKey(pin, salt);

    const plaintext = await hardCrypto.decrypt(
      { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> },
      wrapKey,
      ciphertext,
    );

    const bundle = hardGlobals.jsonParse(new hardGlobals.TextDecoder().decode(plaintext));
    console.log('[PIN_WRAP] Keys decrypted successfully');
    return bundle;
  } catch {
    // Wrong PIN = AES-GCM decryption failure
    console.warn('[PIN_WRAP] Decryption failed (wrong PIN?)');
    return null;
  }
}

/** Check if PIN-wrapped keys exist for a user */
export async function hasWrappedKeys(userId: string): Promise<boolean> {
  try {
    const result = await runTxOn('pin-wrap', [PIN_WRAP_STORE], 'readonly', (tx) =>
      reqToPromise(tx.objectStore(PIN_WRAP_STORE).get(userId)),
    );
    return !!result;
  } catch {
    return false;
  }
}

/** Delete wrapped keys (logout/account deletion) */
export async function deleteWrappedKeys(userId: string): Promise<void> {
  try {
    await runTxOn('pin-wrap', [PIN_WRAP_STORE], 'readwrite', (tx) => {
      tx.objectStore(PIN_WRAP_STORE).delete(userId);
    });
  } catch {}
}
