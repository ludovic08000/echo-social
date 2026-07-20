import {
  AEGIS_MESSAGE_PROTOCOL,
  AEGIS_WIRE_VERSION,
  parseAegisMessageEnvelope,
  type AegisMessageEnvelope,
} from '@/lib/messaging/aegisEnvelope';

export const AEGIS_PROTOCOL = AEGIS_MESSAGE_PROTOCOL;
export const AEGIS_VERSION = AEGIS_WIRE_VERSION;
export const AEGIS_DEVICE_COPY_RATCHET_PREFIX = 'aegis1.ratchet.';
export const AEGIS_DEVICE_COPY_INIT_PREFIX = 'aegis1.init.v1.';

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

/** Exact device-copy formats accepted by both Aegis clients and SQL. */
export function isAegisDeviceCopyWire(body: string | null | undefined): body is string {
  return typeof body === 'string' && (
    body.startsWith(AEGIS_DEVICE_COPY_RATCHET_PREFIX) ||
    body.startsWith(AEGIS_DEVICE_COPY_INIT_PREFIX)
  );
}

export function isKnownCryptoEnvelopeBody(body: string | null | undefined): boolean {
  return isMultiDeviceEnvelopeBody(body);
}

export function isUnsupportedEncryptedBody(body: string | null | undefined): boolean {
  return isCryptoJsonBody(body) && !isMultiDeviceEnvelopeBody(body);
}
