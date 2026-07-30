import { base64ToBuffer, bufferToBase64, randomBytes } from './utils';

export const AEGIS_RATCHET_PREFIX = 'aegis1.ratchet.';
export const AEGIS_INIT_PREFIX = 'aegis1.init.v1.';
export const AEGIS_SESSION_ID_RE = /^s_[A-Za-z0-9_-]{22}$/;

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_RATCHET_WIRE_BYTES = 384 * 1024;
const MAX_INIT_WIRE_BYTES = 512 * 1024;
const MAX_CIPHERTEXT_BYTES = 256 * 1024;
const MAX_COUNTER = 0x7fffffff;

export interface ParsedAegisRatchetPayload {
  sessionId: string;
  dhPubB64: string;
  n: number;
  pn: number;
  ivB64: string;
  ciphertextB64: string;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
}

export function createAegisSessionId(): string {
  const raw = bufferToBase64(randomBytes(16).buffer as ArrayBuffer)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  const id = `s_${raw}`;
  if (!AEGIS_SESSION_ID_RE.test(id)) throw new Error('AEGIS_SESSION_ID_GENERATION_FAILED');
  return id;
}

export function isAegisSessionId(value: string): boolean {
  return AEGIS_SESSION_ID_RE.test(value);
}

function decodeCanonicalBase64(value: string, exactBytes?: number): ArrayBuffer | null {
  if (!value || !BASE64_RE.test(value)) return null;
  try {
    const decoded = base64ToBuffer(value);
    if (exactBytes !== undefined && decoded.byteLength !== exactBytes) return null;
    const canonical = bufferToBase64(decoded);
    if (canonical !== value) return null;
    return decoded;
  } catch {
    return null;
  }
}

function parseCounter(value: string): number | null {
  if (!/^(0|[1-9][0-9]{0,9})$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAX_COUNTER ? parsed : null;
}

export function parseAegisRatchetPayload(
  payload: string | null | undefined,
): ParsedAegisRatchetPayload | null {
  if (typeof payload !== 'string' || !payload.startsWith(AEGIS_RATCHET_PREFIX)) return null;
  if (new TextEncoder().encode(payload).byteLength > MAX_RATCHET_WIRE_BYTES) return null;
  const parts = payload.slice(AEGIS_RATCHET_PREFIX.length).split('.');
  if (parts.length !== 6) return null;
  const [sessionId, dhPubB64, nRaw, pnRaw, ivB64, ciphertextB64] = parts;
  if (!isAegisSessionId(sessionId)) return null;
  const dh = decodeCanonicalBase64(dhPubB64, 32);
  const iv = decodeCanonicalBase64(ivB64, 12);
  const ciphertext = decodeCanonicalBase64(ciphertextB64);
  const n = parseCounter(nRaw);
  const pn = parseCounter(pnRaw);
  if (!dh || !iv || !ciphertext || n === null || pn === null) return null;
  if (ciphertext.byteLength < 16 || ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) return null;
  return {
    sessionId,
    dhPubB64,
    n,
    pn,
    ivB64,
    ciphertextB64,
    iv: new Uint8Array(iv),
    ciphertext,
  };
}

export function isAegisRatchetPayload(value: string | null | undefined): value is string {
  return parseAegisRatchetPayload(value) !== null;
}


export interface ParsedAegisInitialPayload {
  sessionId: string;
  ephemeralKeyB64: string;
  signedPrekeyId: number;
  oneTimePrekeyId?: number;
  senderIdentityKeyB64: string;
  recipientIdentityKeyB64: string;
  innerRatchet: string;
  tagB64: string;
}

function parsePositiveId(value: string): number | null {
  if (!/^[1-9][0-9]{0,9}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_COUNTER ? parsed : null;
}

export function parseAegisInitialPayload(
  payload: string | null | undefined,
): ParsedAegisInitialPayload | null {
  if (typeof payload !== 'string' || !payload.startsWith(AEGIS_INIT_PREFIX)) return null;
  if (new TextEncoder().encode(payload).byteLength > MAX_INIT_WIRE_BYTES) return null;
  const parts = payload.slice(AEGIS_INIT_PREFIX.length).split('.');
  if (parts.length !== 8) return null;
  const [sessionId, ephemeralKeyB64, spkRaw, opkRaw, senderIdentityKeyB64, recipientIdentityKeyB64, innerB64, tagB64] = parts;
  if (!isAegisSessionId(sessionId)) return null;
  const signedPrekeyId = parsePositiveId(spkRaw);
  const oneTimePrekeyId = opkRaw === '0' ? undefined : parsePositiveId(opkRaw);
  if (signedPrekeyId === null || (opkRaw !== '0' && oneTimePrekeyId === null)) return null;
  if (
    !decodeCanonicalBase64(ephemeralKeyB64, 32) ||
    !decodeCanonicalBase64(senderIdentityKeyB64, 32) ||
    !decodeCanonicalBase64(recipientIdentityKeyB64, 32) ||
    !decodeCanonicalBase64(tagB64, 32)
  ) return null;
  const innerBytes = decodeCanonicalBase64(innerB64);
  if (!innerBytes) return null;
  let innerRatchet: string;
  try {
    innerRatchet = new TextDecoder('utf-8', { fatal: true }).decode(innerBytes);
  } catch {
    return null;
  }
  const parsedRatchet = parseAegisRatchetPayload(innerRatchet);
  if (!parsedRatchet || parsedRatchet.sessionId !== sessionId) return null;
  return {
    sessionId,
    ephemeralKeyB64,
    signedPrekeyId,
    oneTimePrekeyId: oneTimePrekeyId ?? undefined,
    senderIdentityKeyB64,
    recipientIdentityKeyB64,
    innerRatchet,
    tagB64,
  };
}

export function isAegisInitialPayload(value: string | null | undefined): value is string {
  return parseAegisInitialPayload(value) !== null;
}
