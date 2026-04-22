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

export function isUnsupportedEncryptedBody(body: string | null | undefined): boolean {
  return isCryptoJsonBody(body) && !isStrictRatchetEnvelopeBody(body);
}