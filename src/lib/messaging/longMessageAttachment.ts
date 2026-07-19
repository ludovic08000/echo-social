import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { base64ToBuffer, bufferToBase64, randomBytes } from '@/lib/crypto/utils';
import { fetchR2Object, uploadToR2 } from '@/lib/r2';

const KIBIBYTE = 1024;

/** Signal Desktop keeps at most 2 KiB of UTF-8 text in the inline body. */
export const MAX_INLINE_MESSAGE_BODY_BYTES = 2 * KIBIBYTE;
/** Signal Desktop caps its encrypted long-body attachment at 64 KiB. */
export const MAX_LONG_MESSAGE_BODY_BYTES = 64 * KIBIBYTE;
export const LONG_MESSAGE_MIME = 'text/x-aegis-plain';

const LONG_MESSAGE_PREFIX = '\u0000AEGIS-LONG-v1:';
const LONG_MESSAGE_AAD_PREFIX = 'AEGIS-LONG-BODY-v1|';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_MARKER_BYTES = MAX_INLINE_MESSAGE_BODY_BYTES + 8 * KIBIBYTE;

export interface LongMessageManifest {
  v: 1;
  id: string;
  mime: typeof LONG_MESSAGE_MIME;
  preview: string;
  url: string;
  key: string;
  size: number;
}

export interface PreparedLongMessage {
  transportBody: string;
  isLong: boolean;
  preview: string;
  uploadedPath?: string;
}

const encoder = new hardGlobals.TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * Slice without ever cutting a UTF-16 surrogate pair. The byte ceiling is the
 * protocol concern; JavaScript character count is not suitable for emoji or
 * accented text.
 */
export function trimUtf8ToBytes(value: string, maxBytes = MAX_INLINE_MESSAGE_BODY_BYTES): string {
  if (maxBytes <= 0 || value.length === 0) return '';
  if (utf8ByteLength(value) <= maxBytes) return value;

  let bytes = 0;
  let result = '';
  for (const codePoint of value) {
    const codePointBytes = encoder.encode(codePoint).byteLength;
    if (bytes + codePointBytes > maxBytes) break;
    result += codePoint;
    bytes += codePointBytes;
  }
  return result;
}

export function isInlineMessageBody(value: string): boolean {
  return utf8ByteLength(value) <= MAX_INLINE_MESSAGE_BODY_BYTES;
}

export function isLongMessageMarker(value: string): boolean {
  return value.startsWith(LONG_MESSAGE_PREFIX);
}

function aadFor(messageId: string, size: number): Uint8Array {
  return encoder.encode(`${LONG_MESSAGE_AAD_PREFIX}${messageId}|${LONG_MESSAGE_MIME}|${size}`);
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 0x1f) return true;
  }
  return false;
}

function isSafeMessageId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 128 &&
    !hasAsciiControlCharacter(value)
  );
}

function parseManifestJson(value: string): LongMessageManifest | null {
  if (!isLongMessageMarker(value) || utf8ByteLength(value) > MAX_MARKER_BYTES) return null;

  try {
    const parsed = JSON.parse(value.slice(LONG_MESSAGE_PREFIX.length)) as Partial<LongMessageManifest>;
    if (
      parsed.v !== 1 ||
      !isSafeMessageId(parsed.id) ||
      parsed.mime !== LONG_MESSAGE_MIME ||
      typeof parsed.preview !== 'string' ||
      utf8ByteLength(parsed.preview) > MAX_INLINE_MESSAGE_BODY_BYTES ||
      typeof parsed.url !== 'string' ||
      parsed.url.length > 4096 ||
      !/^https:\/\//i.test(parsed.url) ||
      typeof parsed.key !== 'string' ||
      parsed.key.length > 128 ||
      typeof parsed.size !== 'number' ||
      !Number.isInteger(parsed.size) ||
      parsed.size <= MAX_INLINE_MESSAGE_BODY_BYTES ||
      parsed.size > MAX_LONG_MESSAGE_BODY_BYTES
    ) {
      return null;
    }

    const keyBytes = base64ToBuffer(parsed.key);
    if (keyBytes.byteLength !== 32) return null;

    return parsed as LongMessageManifest;
  } catch {
    return null;
  }
}

export function parseLongMessageManifest(value: string): LongMessageManifest | null {
  return parseManifestJson(value);
}

export function previewLongMessage(value: string): string | null {
  return parseManifestJson(value)?.preview ?? null;
}

/**
 * Signal-style send preparation:
 * - <= 2 KiB UTF-8: keep the normal body;
 * - > 2 KiB and <= 64 KiB: encrypt the complete text as one attachment and
 *   transport only an authenticated preview + pointer inside the ratchet.
 *
 * This deliberately does not split one logical message into multiple Double
 * Ratchet messages, which would consume several message keys and complicate
 * retries/order semantics.
 */
export async function prepareLongMessageForSend(
  body: string,
  messageId: string,
): Promise<PreparedLongMessage> {
  const size = utf8ByteLength(body);
  if (size <= MAX_INLINE_MESSAGE_BODY_BYTES) {
    return { transportBody: body, isLong: false, preview: body };
  }
  if (size > MAX_LONG_MESSAGE_BODY_BYTES) {
    throw new Error(`Le message est trop long (maximum ${MAX_LONG_MESSAGE_BODY_BYTES / KIBIBYTE} Kio en UTF-8).`);
  }
  if (!isSafeMessageId(messageId)) throw new Error('Identifiant de message long invalide.');

  const key = await hardCrypto.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  ) as CryptoKey;
  const rawKey = await hardCrypto.exportKey('raw', key);
  const iv = randomBytes(IV_BYTES);
  const plaintext = encoder.encode(body);
  const ciphertext = await hardCrypto.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as Uint8Array<ArrayBuffer>,
      additionalData: aadFor(messageId, size),
      tagLength: 128,
    },
    key,
    plaintext,
  );

  const encrypted = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  encrypted.set(iv, 0);
  encrypted.set(new Uint8Array(ciphertext), IV_BYTES);

  const encryptedBlob = new Blob(
    [encrypted.buffer as ArrayBuffer],
    { type: 'application/octet-stream' },
  );
  const uploaded = await uploadToR2(
    encryptedBlob,
    'uploads',
    `${messageId}.long-message.enc`,
  );
  const preview = trimUtf8ToBytes(body);
  const manifest: LongMessageManifest = {
    v: 1,
    id: messageId,
    mime: LONG_MESSAGE_MIME,
    preview,
    url: uploaded.url,
    key: bufferToBase64(rawKey),
    size,
  };

  return {
    transportBody: `${LONG_MESSAGE_PREFIX}${JSON.stringify(manifest)}`,
    isLong: true,
    preview,
    uploadedPath: uploaded.path,
  };
}

/** Download, authenticate and decrypt a long-body attachment. */
export async function resolveLongMessageBody(value: string, messageId: string): Promise<string> {
  const manifest = parseManifestJson(value);
  if (!manifest) throw new Error('Format de message long invalide.');
  if (manifest.id !== messageId) throw new Error('Message long associé à un autre identifiant.');

  const response = await fetchR2Object(manifest.url);
  const expectedEncryptedBytes = IV_BYTES + manifest.size + AUTH_TAG_BYTES;
  const announcedLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(announcedLength) && announcedLength > expectedEncryptedBytes) {
    throw new Error('Pièce jointe de message long surdimensionnée.');
  }

  const encrypted = new Uint8Array(await response.arrayBuffer());
  if (encrypted.byteLength !== expectedEncryptedBytes) {
    throw new Error('Taille de pièce jointe de message long invalide.');
  }

  const key = await hardCrypto.importKey(
    'raw',
    base64ToBuffer(manifest.key),
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plaintext = await hardCrypto.decrypt(
    {
      name: 'AES-GCM',
      iv: encrypted.slice(0, IV_BYTES) as Uint8Array<ArrayBuffer>,
      additionalData: aadFor(messageId, manifest.size),
      tagLength: 128,
    },
    key,
    encrypted.slice(IV_BYTES),
  );

  if (plaintext.byteLength !== manifest.size) {
    throw new Error('Taille du texte long déchiffré invalide.');
  }

  const decoded = new hardGlobals.TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  if (utf8ByteLength(decoded) !== manifest.size) {
    throw new Error('Encodage UTF-8 du message long invalide.');
  }
  if (trimUtf8ToBytes(decoded) !== manifest.preview) {
    throw new Error('Aperçu du message long incohérent.');
  }
  return decoded;
}
