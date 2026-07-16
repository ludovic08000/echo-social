/**
 * Client-side media encryption for private messages.
 *
 * Each file gets a unique AES-256-GCM key. The encrypted blob is uploaded
 * to R2; the per-file key is embedded inside the E2EE message body so the
 * server never sees it.
 *
 * Wire format of the encrypted blob:
 *   IV (12 bytes) || AES-GCM ciphertext+tag
 *
 * New plaintext payloads include an encrypted MIME manifest before the file
 * bytes. Legacy payloads (raw file bytes only) remain readable and are MIME-
 * sniffed after decryption.
 *
 * The per-file key is exported as raw base64 and transmitted inside the
 * message body with a `MKEY:` prefix.
 */

import { hardCrypto } from './cryptoIntegrity';
import { randomBytes, bufferToBase64, base64ToBuffer } from './utils';
import {
  MAX_INCOMING_ATTACHMENT_CIPHERTEXT_BYTES,
  MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES,
  MEDIA_AES_GCM_OVERHEAD_BYTES,
  formatAttachmentLimit,
  isIncomingAttachmentTooLarge,
  isOutgoingAttachmentTooLarge,
} from '@/lib/messaging/attachmentLimits';

const IV_LEN = 12;
const KEY_BITS = 256;
const PAYLOAD_MAGIC = new Uint8Array([0x46, 0x53, 0x4d, 0x31]); // "FSM1"
const PAYLOAD_HEADER_BYTES = PAYLOAD_MAGIC.byteLength + 2;
const MAX_MIME_BYTES = 512;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface DecryptedMediaPayload {
  data: ArrayBuffer;
  mimeType: string | null;
}

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

// ─── MIME manifest / legacy sniffing ───

function normalizeMimeType(value: string | undefined): string {
  const mime = value?.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)
    ? mime
    : 'application/octet-stream';
}

function startsWithBytes(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.byteLength < offset + length) return '';
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

/** Best-effort MIME detection for legacy encrypted media without a manifest. */
export function detectMediaMimeType(bytes: Uint8Array): string | null {
  if (startsWithBytes(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if (ascii(bytes, 0, 4) === '%PDF') return 'application/pdf';

  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brands = new Set<string>();
    for (let offset = 8; offset + 4 <= Math.min(bytes.byteLength, 64); offset += 4) {
      brands.add(ascii(bytes, offset, 4).toLowerCase());
    }
    if (brands.has('avif') || brands.has('avis')) return 'image/avif';
    if ([...brands].some(brand => ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand))) {
      return 'image/heic';
    }
    if (brands.has('qt  ')) return 'video/quicktime';
    return 'video/mp4';
  }

  return null;
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function packMediaPayload(file: File | Blob, fileBytes: Uint8Array): Uint8Array {
  const mimeBytes = textEncoder.encode(normalizeMimeType(file.type));
  if (mimeBytes.byteLength > MAX_MIME_BYTES) throw new Error('Type MIME du média invalide.');

  const payload = new Uint8Array(PAYLOAD_HEADER_BYTES + mimeBytes.byteLength + fileBytes.byteLength);
  payload.set(PAYLOAD_MAGIC, 0);
  payload[PAYLOAD_MAGIC.byteLength] = (mimeBytes.byteLength >>> 8) & 0xff;
  payload[PAYLOAD_MAGIC.byteLength + 1] = mimeBytes.byteLength & 0xff;
  payload.set(mimeBytes, PAYLOAD_HEADER_BYTES);
  payload.set(fileBytes, PAYLOAD_HEADER_BYTES + mimeBytes.byteLength);
  return payload;
}

function unpackMediaPayload(decrypted: Uint8Array): DecryptedMediaPayload {
  const hasManifest = startsWithBytes(decrypted, Array.from(PAYLOAD_MAGIC));
  if (!hasManifest || decrypted.byteLength < PAYLOAD_HEADER_BYTES) {
    return {
      data: copyToArrayBuffer(decrypted),
      mimeType: detectMediaMimeType(decrypted),
    };
  }

  const mimeLength = (decrypted[PAYLOAD_MAGIC.byteLength] << 8) | decrypted[PAYLOAD_MAGIC.byteLength + 1];
  const dataOffset = PAYLOAD_HEADER_BYTES + mimeLength;
  if (mimeLength > MAX_MIME_BYTES || dataOffset > decrypted.byteLength) {
    throw new Error('Manifest du média chiffré invalide.');
  }

  const declaredMime = normalizeMimeType(textDecoder.decode(decrypted.slice(PAYLOAD_HEADER_BYTES, dataOffset)));
  const fileBytes = decrypted.slice(dataOffset);
  const sniffedMime = detectMediaMimeType(fileBytes);
  // The authenticated manifest is useful metadata, but byte signatures are the
  // final rendering authority. This prevents a mislabeled video from entering
  // an <img> loop and handles iOS files whose Blob.type is generic or wrong.
  const resolvedMime = sniffedMime || (declaredMime === 'application/octet-stream' ? null : declaredMime);
  return {
    data: copyToArrayBuffer(fileBytes),
    mimeType: resolvedMime,
  };
}

// ─── Per-file encrypt / decrypt ───

/** Generate a random AES-256-GCM key and export it as base64 */
export async function generateMediaKey(): Promise<{ key: CryptoKey; keyB64: string }> {
  const key = await hardCrypto.generateKey(
    { name: 'AES-GCM', length: KEY_BITS },
    true, // extractable so we can export it inside the E2EE-protected manifest
    ['encrypt', 'decrypt'],
  ) as CryptoKey;

  const raw = await hardCrypto.exportKey('raw', key);
  return { key, keyB64: bufferToBase64(raw) };
}

/** Import a base64 media key back into a non-extractable CryptoKey */
export async function importMediaKey(keyB64: string): Promise<CryptoKey> {
  const raw = base64ToBuffer(keyB64);
  if (raw.byteLength !== KEY_BITS / 8) throw new Error('Clé de média AES-256 invalide.');
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
  const mimeBytes = textEncoder.encode(normalizeMimeType(file.type));
  const estimatedPlaintextBytes = PAYLOAD_HEADER_BYTES + mimeBytes.byteLength + file.size;
  // Reject before arrayBuffer(): Safari/iOS must never allocate an oversized
  // clear file only to discover the limit after the allocation.
  if (isOutgoingAttachmentTooLarge(estimatedPlaintextBytes)) {
    throw new Error(
      `Média trop volumineux : le fichier chiffré ne doit pas dépasser ${formatAttachmentLimit(MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES)}.`,
    );
  }

  const fileBytes = new Uint8Array(await file.arrayBuffer());
  const plaintext = packMediaPayload(file, fileBytes);

  if (isOutgoingAttachmentTooLarge(plaintext.byteLength)) {
    throw new Error(
      `Média trop volumineux : le fichier chiffré ne doit pas dépasser ${formatAttachmentLimit(MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES)}.`,
    );
  }

  const iv = randomBytes(IV_LEN);
  const ciphertext = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
    key,
    plaintext,
  );

  // IV || ciphertext (the ciphertext already includes the 16-byte GCM tag)
  const combined = new Uint8Array(IV_LEN + (ciphertext as ArrayBuffer).byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext as ArrayBuffer), IV_LEN);

  if (combined.byteLength !== plaintext.byteLength + MEDIA_AES_GCM_OVERHEAD_BYTES) {
    throw new Error('Taille du média chiffré incohérente.');
  }

  return new Blob([combined], { type: 'application/octet-stream' });
}

/** Decrypt an encrypted media blob and recover its bytes plus MIME type. */
export async function decryptMediaWithMetadata(
  encryptedData: ArrayBuffer,
  key: CryptoKey,
): Promise<DecryptedMediaPayload> {
  if (isIncomingAttachmentTooLarge(encryptedData.byteLength)) {
    throw new Error(
      `Média reçu trop volumineux : maximum ${formatAttachmentLimit(MAX_INCOMING_ATTACHMENT_CIPHERTEXT_BYTES)}.`,
    );
  }
  if (encryptedData.byteLength < MEDIA_AES_GCM_OVERHEAD_BYTES) {
    throw new Error('Média chiffré tronqué.');
  }

  const data = new Uint8Array(encryptedData);
  const iv = data.slice(0, IV_LEN);
  const ciphertext = data.slice(IV_LEN);
  const decrypted = await hardCrypto.decrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
    key,
    ciphertext,
  ) as ArrayBuffer;

  return unpackMediaPayload(new Uint8Array(decrypted));
}

/**
 * Backward-compatible byte-only decrypt helper used by documents and older
 * call sites. New media renderers should use decryptMediaWithMetadata().
 */
export async function decryptMedia(
  encryptedData: ArrayBuffer,
  key: CryptoKey,
): Promise<ArrayBuffer> {
  return (await decryptMediaWithMetadata(encryptedData, key)).data;
}
