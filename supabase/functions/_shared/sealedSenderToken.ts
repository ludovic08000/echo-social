export const SEALED_SENDER_PROTOCOL_VERSION = 1;
export const SEALED_SENDER_TOKEN_TTL_MS = 5 * 60 * 1000;
export const SEALED_SENDER_MAX_TOKEN_BYTES = 8 * 1024;
export const SEALED_SENDER_MAX_HEADER_BYTES = 16 * 1024;
export const SEALED_SENDER_MAX_PAYLOAD_BYTES = 1_500_000;
export const SEALED_SENDER_MAX_TAG_BYTES = 512;

export interface SealedSenderTokenPayloadV1 {
  version: 1;
  sender_user_id: string;
  recipient_user_id: string;
  conversation_id: string;
  nonce: string;
  issued_at: string;
  expires_at: string;
  context_id: string | null;
}

export interface SignedSealedSenderTokenV1 {
  payload: SealedSenderTokenPayloadV1;
  mac: string;
}

const encoder = new TextEncoder();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function canonicalTokenPayload(payload: SealedSenderTokenPayloadV1): string {
  return JSON.stringify({
    version: payload.version,
    sender_user_id: payload.sender_user_id,
    recipient_user_id: payload.recipient_user_id,
    conversation_id: payload.conversation_id,
    nonce: payload.nonce,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    context_id: payload.context_id,
  });
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid_base64url');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeSignedToken(token: SignedSealedSenderTokenV1): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(token)));
}

export function decodeSignedToken(encoded: string): SignedSealedSenderTokenV1 {
  if (utf8ByteLength(encoded) > SEALED_SENDER_MAX_TOKEN_BYTES) throw new Error('token_too_large');
  const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))) as Partial<SignedSealedSenderTokenV1>;
  const payload = parsed.payload as Partial<SealedSenderTokenPayloadV1> | undefined;
  if (
    !payload ||
    payload.version !== SEALED_SENDER_PROTOCOL_VERSION ||
    !isUuid(payload.sender_user_id) ||
    !isUuid(payload.recipient_user_id) ||
    !isUuid(payload.conversation_id) ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length < 22 ||
    payload.nonce.length > 128 ||
    typeof payload.issued_at !== 'string' ||
    typeof payload.expires_at !== 'string' ||
    (payload.context_id !== null && typeof payload.context_id !== 'string') ||
    typeof parsed.mac !== 'string'
  ) {
    throw new Error('invalid_token');
  }
  return parsed as SignedSealedSenderTokenV1;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signTokenPayload(
  payload: SealedSenderTokenPayloadV1,
  secret: string,
): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalTokenPayload(payload)));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyTokenMac(
  payload: SealedSenderTokenPayloadV1,
  mac: string,
  secret: string,
): Promise<boolean> {
  try {
    const key = await importHmacKey(secret);
    return await crypto.subtle.verify(
      'HMAC',
      key,
      base64UrlToBytes(mac),
      encoder.encode(canonicalTokenPayload(payload)),
    );
  } catch {
    return false;
  }
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function validateTokenTime(
  payload: SealedSenderTokenPayloadV1,
  nowMs = Date.now(),
): 'ok' | 'expired' | 'not_yet_valid' | 'invalid_lifetime' {
  const issuedAt = Date.parse(payload.issued_at);
  const expiresAt = Date.parse(payload.expires_at);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) return 'invalid_lifetime';
  if (expiresAt - issuedAt > SEALED_SENDER_TOKEN_TTL_MS + 5_000) return 'invalid_lifetime';
  if (issuedAt > nowMs + 30_000) return 'not_yet_valid';
  if (expiresAt <= nowMs) return 'expired';
  return 'ok';
}