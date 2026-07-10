/**
 * Local identity-key wrapping.
 *
 * Security boundary:
 * - The encrypted blob, salt and IV are available to any attacker who copies
 *   browser storage, so the wrapping secret MUST resist offline guessing.
 * - New wraps therefore require a high-entropy passphrase. A short numeric PIN
 *   is not an acceptable offline wrapping secret; rate limiting in the UI does
 *   not protect a copied database.
 * - Legacy v1 blobs remain readable for account recovery, but must not be
 *   created again.
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { runTxOn, reqToPromise } from './indexedDbTx';

const PIN_WRAP_STORE = 'pin-wrapped-keys';
const LEGACY_PBKDF2_ITERATIONS = 600_000;
const PBKDF2_ITERATIONS = 1_200_000;
const CURRENT_VERSION = 2;
const MIN_SECRET_LENGTH = 12;

interface WrappedKeyBlob {
  id: string;
  salt: string;
  iv: string;
  ciphertext: string;
  version: number;
  iterations?: number;
}

export class WeakLocalWrappingSecretError extends Error {
  constructor() {
    super('LOCAL_WRAPPING_SECRET_TOO_WEAK: use a passphrase of at least 12 characters; short numeric PINs cannot safely protect an offline key blob.');
    this.name = 'WeakLocalWrappingSecretError';
  }
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

function assertStrongOfflineSecret(secret: string): void {
  const normalized = secret.normalize('NFKC');
  const allDigits = /^\d+$/.test(normalized);
  const hasLetter = /\p{L}/u.test(normalized);
  const hasNonLetter = /[^\p{L}]/u.test(normalized);

  if (
    normalized.length < MIN_SECRET_LENGTH ||
    allDigits ||
    !hasLetter ||
    !hasNonLetter
  ) {
    throw new WeakLocalWrappingSecretError();
  }
}

function buildAAD(userId: string, version: number): Uint8Array {
  return new hardGlobals.TextEncoder().encode(`forsure-local-key-wrap|${userId}|v${version}`);
}

async function deriveWrappingKey(secret: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const secretBytes = new hardGlobals.TextEncoder().encode(secret.normalize('NFKC'));
  const baseKey = await hardCrypto.importKey('raw', secretBytes, 'PBKDF2', false, ['deriveKey']);
  return hardCrypto.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

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
  assertStrongOfflineSecret(pin);

  const salt = hardCrypto.getRandomValues(new Uint8Array(32));
  const iv = hardCrypto.getRandomValues(new Uint8Array(12));
  const wrapKey = await deriveWrappingKey(pin, salt, PBKDF2_ITERATIONS);
  const plaintext = new hardGlobals.TextEncoder().encode(hardGlobals.jsonStringify(jwkBundle));
  const aad = buildAAD(userId, CURRENT_VERSION);
  const ciphertext = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, additionalData: aad },
    wrapKey,
    plaintext,
  );

  const blob: WrappedKeyBlob = {
    id: userId,
    salt: bufToB64(salt.buffer as ArrayBuffer),
    iv: bufToB64(iv.buffer as ArrayBuffer),
    ciphertext: bufToB64(ciphertext),
    version: CURRENT_VERSION,
    iterations: PBKDF2_ITERATIONS,
  };

  await runTxOn('pin-wrap', [PIN_WRAP_STORE], 'readwrite', (tx) => {
    tx.objectStore(PIN_WRAP_STORE).put(blob);
  });

  console.log('[PIN_WRAP] Keys encrypted with offline-resistant passphrase policy');
}

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
    const version = Number.isInteger(blob.version) ? blob.version : 1;
    const iterations = version >= 2
      ? Math.max(PBKDF2_ITERATIONS, blob.iterations ?? PBKDF2_ITERATIONS)
      : LEGACY_PBKDF2_ITERATIONS;
    const wrapKey = await deriveWrappingKey(pin, salt, iterations);
    const params: AesGcmParams = version >= 2
      ? { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, additionalData: buildAAD(userId, version) }
      : { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer> };

    const plaintext = await hardCrypto.decrypt(params, wrapKey, ciphertext);
    const bundle = hardGlobals.jsonParse(new hardGlobals.TextDecoder().decode(plaintext));

    if (!bundle?.privateKeyJWK || !bundle?.signingPrivateKeyJWK || !bundle?.fingerprint) {
      throw new Error('PIN_WRAP_INVALID_PAYLOAD');
    }

    console.log('[PIN_WRAP] Keys decrypted successfully');
    return bundle;
  } catch {
    console.warn('[PIN_WRAP] Decryption failed');
    return null;
  }
}

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

export async function deleteWrappedKeys(userId: string): Promise<void> {
  try {
    await runTxOn('pin-wrap', [PIN_WRAP_STORE], 'readwrite', (tx) => {
      tx.objectStore(PIN_WRAP_STORE).delete(userId);
    });
  } catch {}
}
