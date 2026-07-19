import {
  AEGIS_MESSAGE_PROTOCOL,
  AEGIS_WIRE_VERSION,
  parseAegisMessageEnvelope,
  type AegisMessageEnvelope,
} from '@/lib/messaging/aegisEnvelope';

export const AEGIS_PROTOCOL = AEGIS_MESSAGE_PROTOCOL;
export const AEGIS_VERSION = AEGIS_WIRE_VERSION;

export type MultiDeviceEnvelopeShape = AegisMessageEnvelope;

export function isCryptoJsonBody(body: string | null | undefined): boolean {
  if (!body || typeof body !== 'string' || !body.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return ['protocol', 'encryptionMode', 'ciphertext', 'keyTransport', 'ct', 'hdr', 'kem']
      .some((key) => Object.prototype.hasOwnProperty.call(parsed, key));
  } catch {
    return false;
  }
}

export function isMultiDeviceEnvelopeBody(body: string | null | undefined): body is string {
  return parseAegisMessageEnvelope(body) !== null;
}

export function isKnownCryptoEnvelopeBody(body: string | null | undefined): boolean {
  return isMultiDeviceEnvelopeBody(body);
}

export function isUnsupportedEncryptedBody(body: string | null | undefined): boolean {
  return isCryptoJsonBody(body) && !isMultiDeviceEnvelopeBody(body);
}
