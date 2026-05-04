/**
 * Cryptographic utility functions
 * All calls use hardened references from cryptoIntegrity.ts
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';

/** Convert ArrayBuffer to Base64 string (Signal-style: always use clean copy) */
export function bufferToBase64(buffer: ArrayBuffer): string {
  // Signal safety: slice() ensures we read from offset 0 with correct length
  // even if the buffer is a view into a larger backing store
  const bytes = new Uint8Array(buffer.byteLength !== undefined ? buffer : new ArrayBuffer(0));
  const clean = bytes.slice();
  let binary = '';
  for (let i = 0; i < clean.byteLength; i++) {
    binary += String.fromCharCode(clean[i]);
  }
  return hardGlobals.btoa(binary);
}

/** Convert Base64 string to ArrayBuffer (always returns clean buffer at offset 0) */
export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = hardGlobals.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // .slice() guarantees byteOffset=0 and correct byteLength
  return bytes.slice().buffer;
}

/** Generate cryptographically secure random bytes */
export function randomBytes(length: number): Uint8Array {
  return hardCrypto.getRandomValues(new Uint8Array(length));
}

/** Constant-time comparison to prevent timing attacks */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

/** Hash data with SHA-384 */
export async function sha384(data: ArrayBuffer): Promise<ArrayBuffer> {
  return hardCrypto.digest('SHA-384', data);
}

/** Concatenate multiple ArrayBuffers */
export function concatBuffers(...buffers: ArrayBuffer[]): ArrayBuffer {
  const totalLength = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buffer of buffers) {
    result.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return result.buffer;
}

/** Encode string to ArrayBuffer (Signal-style: .slice() for clean buffer) */
export function encodeString(str: string): ArrayBuffer {
  const encoded = new hardGlobals.TextEncoder().encode(str);
  return encoded.slice().buffer;
}

/** Decode ArrayBuffer to string */
export function decodeString(buffer: ArrayBuffer): string {
  return new hardGlobals.TextDecoder().decode(buffer);
}

/** Export CryptoKey to JWK for storage */
export async function exportKeyToJWK(key: CryptoKey): Promise<JsonWebKey> {
  return hardCrypto.exportKey('jwk', key);
}

function normalizeJWKForImport(
  jwk: JsonWebKey,
  usages: KeyUsage[],
  extractable: boolean,
): JsonWebKey {
  const normalized: JsonWebKey = { ...jwk };

  // Safari/iOS is stricter than Chromium when JWK metadata disagrees with the
  // import arguments. Key material is the same; these fields only describe how
  // WebCrypto should expose the imported CryptoKey.
  normalized.key_ops = [...usages];
  normalized.ext = extractable;
  delete normalized.alg;

  return normalized;
}

/** Import CryptoKey from JWK */
export async function importKeyFromJWK(
  jwk: JsonWebKey,
  algorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams,
  usages: KeyUsage[],
  extractable: boolean = true,
): Promise<CryptoKey> {
  const normalized = normalizeJWKForImport(jwk, usages, extractable);
  try {
    return await hardCrypto.importKey('jwk', normalized, algorithm, extractable, usages);
  } catch (primaryErr) {
    const relaxed: JsonWebKey = { ...jwk };
    delete relaxed.key_ops;
    delete relaxed.ext;
    delete relaxed.alg;
    try {
      return await hardCrypto.importKey('jwk', relaxed, algorithm, extractable, usages);
    } catch (fallbackErr) {
      const primary = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const fallback = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(`JWK import failed (normalized: ${primary}; relaxed: ${fallback})`);
    }
  }
}
