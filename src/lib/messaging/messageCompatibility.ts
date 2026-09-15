import {
  AEGIS_MESSAGE_PROTOCOL,
  AEGIS_WIRE_VERSION,
  parseAegisMessageEnvelope,
  type AegisMessageEnvelope,
} from '@/lib/messaging/aegisEnvelope';
import { decodeLibsignalWire } from '@/lib/crypto/libsignalWire';

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

/**
 * Invariant cryptographique : la seule capsule d'appareil acceptée est le fil
 * libsignal. Les anciens formats `aegis1.*` ne sont plus déchiffrables et
 * doivent rester « non supportés », jamais repris par un chemin de secours.
 */
export function isAegisDeviceCopyWire(body: string | null | undefined): body is string {
  return typeof body === 'string' && decodeLibsignalWire(body) !== null;
}

export function isKnownCryptoEnvelopeBody(body: string | null | undefined): boolean {
  return isMultiDeviceEnvelopeBody(body);
}

export function isUnsupportedEncryptedBody(body: string | null | undefined): boolean {
  if (typeof body === 'string' && (body.startsWith('aegis1.ratchet.') || body.startsWith('aegis1.init.'))) {
    return true;
  }
  return isCryptoJsonBody(body) && !isMultiDeviceEnvelopeBody(body);
}
