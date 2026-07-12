import { PROTOCOL_VERSION } from '@/lib/crypto/constants';

export interface StrictRatchetEnvelopeShape {
  encryptionMode: 'ratchet';
  v: number;
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

export function isSecurePipelineEnvelopeBody(body: string | null | undefined): body is string {
  if (!body || typeof body !== 'string' || !body.startsWith('{')) return false;

  try {
    const parsed = JSON.parse(body) as Partial<SecurePipelineEnvelopeShape>;
    return parsed.fs_secure_pipeline === 1 && typeof parsed.body === 'string' && parsed.body.length > 0;
  } catch {
    return false;
  }
}

export function isCryptoJsonBody(body: string | null | undefined): boolean {
  if (!body || typeof body !== 'string' || !body.startsWith('{')) return false;
  return body.includes('"ct"') || body.includes('"hdr"') || body.includes('"kem"') || body.includes('"encryptionMode"') || body.includes('"fs_secure_pipeline"');
}

export function isStrictRatchetEnvelopeBody(body: string | null | undefined): body is string {
  if (!body || typeof body !== 'string' || !body.startsWith('{')) return false;

  try {
    const parsed = JSON.parse(body) as Partial<StrictRatchetEnvelopeShape> & { kem?: string };
    const modeOk =
      parsed.encryptionMode === 'ratchet' ||
      (parsed.encryptionMode === undefined && parsed.kem === 'X25519');
    return (
      modeOk &&
      parsed.v === PROTOCOL_VERSION &&
      typeof parsed.iv === 'string' && parsed.iv.length > 0 &&
      typeof parsed.ct === 'string' && parsed.ct.length > 0 &&
      typeof parsed.sig === 'string' && parsed.sig.length > 0 &&
      typeof parsed.fp === 'string' && parsed.fp.length > 0 &&
      typeof parsed.ts === 'number' &&
      !!parsed.hdr &&
      typeof parsed.hdr.dh === 'string' && parsed.hdr.dh.length > 0 &&
      typeof parsed.hdr.n === 'number' &&
      typeof parsed.hdr.pn === 'number'
    );
  } catch {
    return false;
  }
}

export function isMultiDeviceEnvelopeBody(body: string | null | undefined): body is string {
  if (!body || typeof body !== 'string' || !body.startsWith('{')) return false;

  try {
    const parsed = JSON.parse(body) as Partial<MultiDeviceEnvelopeShape>;
    return (
      parsed.encryptionMode === 'multi_device' &&
      parsed.v === PROTOCOL_VERSION &&
      parsed.ct === 'device_copies' &&
      typeof parsed.ts === 'number'
    );
  } catch {
    return false;
  }
}

export function isKnownCryptoEnvelopeBody(body: string | null | undefined): boolean {
  if (!isCryptoJsonBody(body)) return false;

  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

    if (parsed.fs_secure_pipeline === 1 && typeof parsed.body === 'string') {
      return true;
    }

    if (isStrictRatchetEnvelopeBody(body)) return true;
    if (isMultiDeviceEnvelopeBody(body)) return true;

    const hdr = parsed.hdr;
    const hasRatchetHeader =
      !!hdr &&
      typeof hdr === 'object' &&
      typeof hdr.dh === 'string' &&
      typeof hdr.n === 'number' &&
      typeof hdr.pn === 'number';

    if (
      typeof parsed.ct === 'string' &&
      typeof parsed.iv === 'string' &&
      hasRatchetHeader
    ) {
      return true;
    }

    if (
      parsed.version === 4 &&
      typeof parsed.ciphertext === 'string' &&
      typeof parsed.sessionId === 'string'
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Crypto rows are never removed from the UI merely because this build does not
 * recognise their current envelope version. They remain opaque recovery
 * bubbles: plaintext cache, device copies, archives, or a future app update can
 * still recover them. Explicit user deletion remains the only local hide path.
 */
export function isUnsupportedEncryptedBody(_body: string | null | undefined): boolean {
  return false;
}
