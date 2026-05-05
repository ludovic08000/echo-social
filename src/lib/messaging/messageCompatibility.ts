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

export function isCryptoJsonBody(body: string | null | undefined): boolean {
  if (!body || typeof body !== 'string' || !body.startsWith('{')) return false;
  return body.includes('"ct"') || body.includes('"hdr"') || body.includes('"kem"') || body.includes('"encryptionMode"');
}

export function isStrictRatchetEnvelopeBody(body: string | null | undefined): body is string {
  if (!body || typeof body !== 'string' || !body.startsWith('{')) return false;

  try {
    const parsed = JSON.parse(body) as Partial<StrictRatchetEnvelopeShape> & { kem?: string };
    // Accept either:
    //   - the current strict envelope (encryptionMode === 'ratchet')
    //   - the legacy v2 envelope that omitted `encryptionMode` but carried
    //     the same ratchet header + X25519 kem. The decryption pipeline
    //     handles both, so we must NOT mark legacy bodies as unsupported
    //     (which would hide them as "anciens messages chiffrés").
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

    if (isStrictRatchetEnvelopeBody(body)) return true;
    if (isMultiDeviceEnvelopeBody(body)) return true;

    const hdr = parsed.hdr;
    const hasRatchetHeader =
      !!hdr &&
      typeof hdr === 'object' &&
      typeof hdr.dh === 'string' &&
      typeof hdr.n === 'number' &&
      typeof hdr.pn === 'number';

    // Legacy conversation-level ratchet payloads may have older `v` values
    // or miss the newer encryptionMode tag. They are still recoverable through
    // device-copy / plaintext-cache fallbacks, so they must not be persisted as
    // "deleted for me" just because the current strict parser cannot decrypt
    // them immediately after a session restore.
    if (
      typeof parsed.ct === 'string' &&
      typeof parsed.iv === 'string' &&
      hasRatchetHeader
    ) {
      return true;
    }

    // Structured v4 facade used by e2ee-session diagnostics/router.
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

export function isUnsupportedEncryptedBody(body: string | null | undefined): boolean {
  return isCryptoJsonBody(body) && !isKnownCryptoEnvelopeBody(body);
}
