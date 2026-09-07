import { base64ToBuffer, bufferToBase64 } from './utils';

export const LIBSIGNAL_WIRE_PREFIX = 'aegis.libsignal.';

function bytes64(bytes: Uint8Array): string {
  return bufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

export function encodeLibsignalWire(messageType: number, ciphertext: Uint8Array): string {
  if (messageType !== 2 && messageType !== 3) throw new Error('AEGIS_LIBSIGNAL_TYPE_INVALID');
  if (!ciphertext.byteLength) throw new Error('AEGIS_LIBSIGNAL_CIPHERTEXT_EMPTY');
  return `${LIBSIGNAL_WIRE_PREFIX}${messageType}.${bytes64(ciphertext)}`;
}

export function decodeLibsignalWire(value: string): { messageType: number; ciphertext: Uint8Array } | null {
  // Le client et SQL acceptent uniquement Signal/PreKey en base64 canonique.
  if (!/^aegis\.libsignal\.[23]\.[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const [rawType, encoded, ...extra] = value.slice(LIBSIGNAL_WIRE_PREFIX.length).split('.');
  const messageType = Number(rawType);
  if (extra.length || !encoded || !Number.isInteger(messageType) || messageType < 0 || messageType > 255) return null;
  try {
    const ciphertext = new Uint8Array(base64ToBuffer(encoded));
    if (!ciphertext.byteLength || bytes64(ciphertext) !== encoded) return null;
    return { messageType, ciphertext };
  } catch { return null; }
}
