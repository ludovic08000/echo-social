import { base64ToBuffer, bufferToBase64, randomBytes } from '@/lib/crypto/utils';

export const AEGIS_RATCHET_PREFIX = 'aegis1.ratchet.';
export const AEGIS_INIT_PREFIX = 'aegis1.init.v1.';

export const AEGIS_MAX_DEVICE_COPY_BYTES = 128 * 1024;
export const AEGIS_MAX_RATCHET_CIPHERTEXT_BYTES = 64 * 1024;
export const AEGIS_MAX_RATCHET_COUNTER = 10_000_000;

const LEGACY_HEADER_BOUND_SESSION_RE = /^s6[A-Za-z0-9]{8,10}$/;
const CURRENT_SESSION_RE = /^s7[A-Za-z0-9_-]{22}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,9})$/;
const POSITIVE_DECIMAL_RE = /^[1-9][0-9]{0,9}$/;

export interface ParsedAegisRatchetWire {
  sessionId: string;
  dhPubB64: string;
  n: number;
  pn: number;
  ivB64: string;
  ciphertextB64: string;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

export interface ParsedAegisInitWire {
  sessionId: string;
  ekB64: string;
  spkId: number;
  opkId?: number;
  senderIdentityKeyB64: string;
  recipientIdentityKeyB64: string;
  innerRatchet: string;
  tagB64: string;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function decodeBase64Within(
  value: string,
  minBytes: number,
  maxBytes: number,
): ArrayBuffer | null {
  if (!value || value.length > Math.ceil(maxBytes / 3) * 4 + 4) return null;
  try {
    const decoded = base64ToBuffer(value);
    return decoded.byteLength >= minBytes && decoded.byteLength <= maxBytes ? decoded : null;
  } catch {
    return null;
  }
}

function parseCounter(value: string, positive = false): number | null {
  if (!(positive ? POSITIVE_DECIMAL_RE : DECIMAL_RE).test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (positive ? 1 : 0)) return null;
  if (parsed > AEGIS_MAX_RATCHET_COUNTER) return null;
  return parsed;
}

export function createAegisSessionId(): string {
  const raw = randomBytes(16);
  return `s7${bufferToBase64(raw.buffer as ArrayBuffer)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')}`;
}

/** s6 is retained only because it already authenticates its header. */
export function isHeaderBoundAegisSessionId(value: string): boolean {
  return LEGACY_HEADER_BOUND_SESSION_RE.test(value) || CURRENT_SESSION_RE.test(value);
}

export function parseAegisRatchetWire(
  payload: string | null | undefined,
): ParsedAegisRatchetWire | null {
  if (!payload || !payload.startsWith(AEGIS_RATCHET_PREFIX)) return null;
  if (utf8Length(payload) > AEGIS_MAX_DEVICE_COPY_BYTES) return null;

  const parts = payload.slice(AEGIS_RATCHET_PREFIX.length).split('.');
  if (parts.length !== 6) return null;
  const [sessionId, dhPubB64, nRaw, pnRaw, ivB64, ciphertextB64] = parts;
  if (!isHeaderBoundAegisSessionId(sessionId)) return null;

  const n = parseCounter(nRaw);
  const pn = parseCounter(pnRaw);
  const dhPub = decodeBase64Within(dhPubB64, 32, 32);
  const ivBuffer = decodeBase64Within(ivB64, 12, 12);
  const ciphertext = decodeBase64Within(
    ciphertextB64,
    16,
    AEGIS_MAX_RATCHET_CIPHERTEXT_BYTES,
  );
  if (n === null || pn === null || !dhPub || !ivBuffer || !ciphertext) return null;

  return {
    sessionId,
    dhPubB64,
    n,
    pn,
    ivB64,
    ciphertextB64,
    iv: new Uint8Array(ivBuffer),
    ciphertext,
  };
}

export function parseAegisInitWire(
  payload: string | null | undefined,
): ParsedAegisInitWire | null {
  if (!payload || !payload.startsWith(AEGIS_INIT_PREFIX)) return null;
  if (utf8Length(payload) > AEGIS_MAX_DEVICE_COPY_BYTES) return null;

  const parts = payload.slice(AEGIS_INIT_PREFIX.length).split('.');
  if (parts.length !== 8) return null;
  const [
    sessionId,
    ekB64,
    spkRaw,
    opkRaw,
    senderIdentityKeyB64,
    recipientIdentityKeyB64,
    innerB64,
    tagB64,
  ] = parts;
  if (!isHeaderBoundAegisSessionId(sessionId)) return null;

  const spkId = parseCounter(spkRaw, true);
  const opkId = opkRaw === '0' ? undefined : parseCounter(opkRaw, true);
  if (spkId === null || (opkRaw !== '0' && opkId === null)) return null;
  if (!decodeBase64Within(ekB64, 32, 32)) return null;
  if (!decodeBase64Within(senderIdentityKeyB64, 32, 32)) return null;
  if (!decodeBase64Within(recipientIdentityKeyB64, 32, 32)) return null;
  if (!decodeBase64Within(tagB64, 32, 32)) return null;

  const innerBytes = decodeBase64Within(
    innerB64,
    AEGIS_RATCHET_PREFIX.length + 1,
    AEGIS_MAX_DEVICE_COPY_BYTES,
  );
  if (!innerBytes) return null;

  let innerRatchet: string;
  try {
    innerRatchet = new TextDecoder('utf-8', { fatal: true }).decode(innerBytes);
  } catch {
    return null;
  }
  const parsedInner = parseAegisRatchetWire(innerRatchet);
  if (!parsedInner || parsedInner.sessionId !== sessionId) return null;

  return {
    sessionId,
    ekB64,
    spkId,
    opkId: opkId ?? undefined,
    senderIdentityKeyB64,
    recipientIdentityKeyB64,
    innerRatchet,
    tagB64,
  };
}

export function isAegisDeviceCopyWireStrict(
  payload: string | null | undefined,
): payload is string {
  return parseAegisRatchetWire(payload) !== null || parseAegisInitWire(payload) !== null;
}
