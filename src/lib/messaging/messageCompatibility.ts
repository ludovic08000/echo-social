import { PROTOCOL_VERSION } from '@/lib/crypto/constants';

export const SESAME_LITE_PROTOCOL = 'forsure-sesame-lite';
export const SESAME_LITE_VERSION = 1;

export interface MultiDeviceEnvelopeShape {
  protocol: typeof SESAME_LITE_PROTOCOL;
  version: typeof SESAME_LITE_VERSION;
  encryptionMode: 'multi_device';
  v: number;
  ct: 'device_copies';
  ts: number;
}

export function isCryptoJsonBody(body: string | null | undefined): boolean {
  if (!body || typeof body !== 'string' || !body.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return ['protocol', 'encryptionMode', 'ct', 'hdr', 'kem']
      .some((key) => Object.prototype.hasOwnProperty.call(parsed, key));
  } catch {
    return false;
  }
}

export function isMultiDeviceEnvelopeBody(body: string | null | undefined): body is string {
  if (!body || typeof body !== 'string' || !body.startsWith('{')) return false;

  try {
    const parsed = JSON.parse(body) as Partial<MultiDeviceEnvelopeShape>;
    return (
      parsed.protocol === SESAME_LITE_PROTOCOL &&
      parsed.version === SESAME_LITE_VERSION &&
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
  return isMultiDeviceEnvelopeBody(body);
}

export function isUnsupportedEncryptedBody(body: string | null | undefined): boolean {
  return isCryptoJsonBody(body) && !isMultiDeviceEnvelopeBody(body);
}
