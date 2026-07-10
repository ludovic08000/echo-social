import { PROTOCOL_VERSION } from '@/lib/crypto/constants';

const MIN_SUPPORTED_RATCHET_VERSION = 2;
const MAX_ENCODED_FIELD_LENGTH = 2_000_000;
const MAX_HEADER_COUNTER = Number.MAX_SAFE_INTEGER;

export interface StrictRatchetEnvelopeShape {
  encryptionMode?: 'ratchet';
  v: number;
  kem?: string;
  hdr: {
    dh: string;
    pn: number;
    n: number;
  };
  iv: string;
  ct: string;
  sig: string;
  fp: string;
  ts: number;
}

export interface MultiDeviceEnvelopeShape {
  encryptionMode: 'multi_device';
  v: number;
  ct: 'device_copies';
  ts: number;
}

export interface SecurePipelineEnvelopeShape {
  fs_secure_pipeline: 1;
  body: string;
  meta?: unknown;
}

function parseObject(body: string | null | undefined): Record<string, unknown> | null {
  if (!body || typeof body !== 'string' || !body.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ENCODED_FIELD_LENGTH;
}

function isCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_HEADER_COUNTER;
}

function isSupportedRatchetVersion(value: unknown): value is number {
  return Number.isInteger(value) &&
    (value as number) >= MIN_SUPPORTED_RATCHET_VERSION &&
    (value as number) <= PROTOCOL_VERSION;
}

export function isSecurePipelineEnvelopeBody(body: string | null | undefined): body is string {
  const parsed = parseObject(body) as Partial<SecurePipelineEnvelopeShape> | null;
  return !!parsed && parsed.fs_secure_pipeline === 1 && isBoundedString(parsed.body);
}

export function isCryptoJsonBody(body: string | null | undefined): boolean {
  const parsed = parseObject(body);
  if (!parsed) return false;

  return parsed.fs_secure_pipeline === 1 ||
    parsed.encryptionMode === 'ratchet' ||
    parsed.encryptionMode === 'multi_device' ||
    parsed.kem === 'X25519' ||
    ('hdr' in parsed && 'ct' in parsed && 'iv' in parsed);
}

export function isStrictRatchetEnvelopeBody(body: string | null | undefined): body is string {
  const parsed = parseObject(body) as (Partial<StrictRatchetEnvelopeShape> & { hdr?: Partial<StrictRatchetEnvelopeShape['hdr']> }) | null;
  if (!parsed) return false;

  // Current messages are explicitly tagged. Historical v2/v3 messages may omit
  // the tag, but are only routed as ratchet envelopes when the KEM is X25519.
  const modeOk = parsed.encryptionMode === 'ratchet' ||
    (parsed.encryptionMode === undefined && parsed.kem === 'X25519');

  return modeOk &&
    isSupportedRatchetVersion(parsed.v) &&
    isBoundedString(parsed.iv) &&
    isBoundedString(parsed.ct) &&
    isBoundedString(parsed.sig) &&
    isBoundedString(parsed.fp) &&
    typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) && parsed.ts > 0 &&
    !!parsed.hdr &&
    isBoundedString(parsed.hdr.dh) &&
    isCounter(parsed.hdr.n) &&
    isCounter(parsed.hdr.pn);
}

export function isMultiDeviceEnvelopeBody(body: string | null | undefined): body is string {
  const parsed = parseObject(body) as Partial<MultiDeviceEnvelopeShape> | null;
  return !!parsed &&
    parsed.encryptionMode === 'multi_device' &&
    parsed.v === PROTOCOL_VERSION &&
    parsed.ct === 'device_copies' &&
    typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) && parsed.ts > 0;
}

export function isKnownCryptoEnvelopeBody(body: string | null | undefined): boolean {
  if (!isCryptoJsonBody(body)) return false;

  const parsed = parseObject(body);
  if (!parsed) return false;

  if (parsed.fs_secure_pipeline === 1 && isBoundedString(parsed.body)) return true;
  if (isStrictRatchetEnvelopeBody(body)) return true;
  if (isMultiDeviceEnvelopeBody(body)) return true;

  const hdr = parsed.hdr as Record<string, unknown> | undefined;
  const hasRatchetHeader = !!hdr &&
    typeof hdr === 'object' &&
    isBoundedString(hdr.dh) &&
    isCounter(hdr.n) &&
    isCounter(hdr.pn);

  // Keep structurally valid historical ciphertext visible for explicit recovery,
  // but do not pass it into the live ratchet unless its declared version is
  // supported by isStrictRatchetEnvelopeBody().
  if (isBoundedString(parsed.ct) && isBoundedString(parsed.iv) && hasRatchetHeader) {
    return true;
  }

  if (parsed.version === 4 && isBoundedString(parsed.ciphertext) && isBoundedString(parsed.sessionId)) {
    return true;
  }

  return false;
}

export function isUnsupportedEncryptedBody(body: string | null | undefined): boolean {
  return isCryptoJsonBody(body) && !isKnownCryptoEnvelopeBody(body);
}
