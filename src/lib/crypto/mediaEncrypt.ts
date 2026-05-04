/**
 * Client-side media encryption for private messages.
 *
 * Each file gets a unique AES-256-GCM key.  The encrypted blob is uploaded
 * to R2; the per-file key is embedded inside the E2EE message body so the
 * server never sees it.
 *
 * Wire format of the encrypted blob:
 *   IV (12 bytes) || AES-GCM ciphertext+tag
 *
 * The per-file key is exported as raw base64 and transmitted inside the
 * message body with a `MKEY:` prefix.
 */

import { hardCrypto } from './cryptoIntegrity';
import { randomBytes, bufferToBase64, base64ToBuffer } from './utils';

const IV_LEN = 12;
const KEY_BITS = 256;

// ─── Delimiters used inside the E2EE message body ───

/** Separator between the human-readable label and the media key */
export const MEDIA_KEY_SEPARATOR = '\x00MKEY:';

/** Detect whether a decrypted message body contains an embedded media key */
export function hasMediaKey(plaintext: string): boolean {
  return plaintext.includes(MEDIA_KEY_SEPARATOR);
}

/** Extract the label (e.g. "📷 Photo") and the base64 media key */
export function parseMediaMessage(plaintext: string): { label: string; keyB64: string } | null {
  const idx = plaintext.indexOf(MEDIA_KEY_SEPARATOR);
  if (idx === -1) return null;
  return {
    label: plaintext.slice(0, idx),
    keyB64: plaintext.slice(idx + MEDIA_KEY_SEPARATOR.length),
  };
}

export function isVideoMediaLabel(label: string): boolean {
  const lower = label.toLowerCase().trim();
  return (
    label.includes('\u{1F3AC}') ||
    lower === 'video' ||
    lower === 'vidéo' ||
    lower === 'vidã©o' ||
    lower.endsWith(' video') ||
    lower.endsWith(' vidéo') ||
    lower.endsWith(' vidã©o')
  );
}

export function isImageMediaLabel(label: string): boolean {
  const lower = label.toLowerCase().trim();
  return (
    label.includes('\u{1F4F7}') ||
    lower === 'photo' ||
    lower === 'image' ||
    lower.endsWith(' photo') ||
    lower.endsWith(' image')
  );
}

/** Build a message body with an embedded media key */
export function buildMediaMessageBody(label: string, keyB64: string): string {
  return `${label}${MEDIA_KEY_SEPARATOR}${keyB64}`;
}

// ─── Per-file encrypt / decrypt ───

/** Generate a random AES-256-GCM key and export it as base64 */
export async function generateMediaKey(): Promise<{ key: CryptoKey; keyB64: string }> {
  const key = await hardCrypto.generateKey(
    { name: 'AES-GCM', length: KEY_BITS },
    true, // extractable so we can export
    ['encrypt', 'decrypt'],
  ) as CryptoKey;

  const raw = await hardCrypto.exportKey('raw', key);
  return { key, keyB64: bufferToBase64(raw) };
}

/** Import a base64 media key back into a CryptoKey */
export async function importMediaKey(keyB64: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(keyB64);
  return hardCrypto.importKey(
    'raw',
    raw,
    { name: 'AES-GCM', length: KEY_BITS },
    false,
    ['decrypt'],
  );
}

/**
 * Encrypt a file (Blob/File) with AES-256-GCM.
 * Returns a new Blob containing IV || ciphertext.
 */
export async function encryptMedia(
  file: File | Blob,
  key: CryptoKey,
): Promise<Blob> {
  const iv = randomBytes(IV_LEN);
  const plaintext = await file.arrayBuffer();

  const ciphertext = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
    key,
    plaintext,
  );

  // IV || ciphertext (includes auth tag)
  const combined = new Uint8Array(IV_LEN + (ciphertext as ArrayBuffer).byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext as ArrayBuffer), IV_LEN);

  return new Blob([combined], { type: 'application/octet-stream' });
}

/**
 * Decrypt an encrypted media blob (IV || ciphertext) → original ArrayBuffer.
 */
export async function decryptMedia(
  encryptedData: ArrayBuffer,
  key: CryptoKey,
): Promise<ArrayBuffer> {
  const data = new Uint8Array(encryptedData);
  const iv = data.slice(0, IV_LEN);
  const ciphertext = data.slice(IV_LEN);

  return hardCrypto.decrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
    key,
    ciphertext,
  ) as Promise<ArrayBuffer>;
}
