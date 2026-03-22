/**
 * Cryptographic utility functions
 */

/** Convert ArrayBuffer to Base64 string */
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Convert Base64 string to ArrayBuffer */
export function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** Generate cryptographically secure random bytes */
export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
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
  return crypto.subtle.digest('SHA-384', data);
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

/** Encode string to ArrayBuffer */
export function encodeString(str: string): ArrayBuffer {
  return new TextEncoder().encode(str).buffer;
}

/** Decode ArrayBuffer to string */
export function decodeString(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}

/** Export CryptoKey to JWK for storage */
export async function exportKeyToJWK(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey('jwk', key);
}

/** Import CryptoKey from JWK */
export async function importKeyFromJWK(
  jwk: JsonWebKey,
  algorithm: AlgorithmIdentifier | RsaHashedImportParams | EcKeyImportParams,
  usages: KeyUsage[]
): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', jwk, algorithm, true, usages);
}
