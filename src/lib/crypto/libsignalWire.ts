import { base64ToBuffer, bufferToBase64 } from './utils';

export const LIBSIGNAL_WIRE_PREFIX = 'aegis.libsignal.';

function bytes64(bytes: Uint8Array): string {
  return bufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

export function encodeLibsignalWire(messageType: number, ciphertext: Uint8Array): string {
  if (!Number.isInteger(messageType) || messageType < 0 || messageType > 255) throw new Error('AEGIS_LIBSIGNAL_TYPE_INVALID');
  return `${LIBSIGNAL_WIRE_PREFIX}${messageType}.${bytes64(ciphertext)}`;
}

export function decodeLibsignalWire(value: string): { messageType: number; ciphertext: Uint8Array } | null {
  if (!value.startsWith(LIBSIGNAL_WIRE_PREFIX)) return null;
  const [rawType, encoded, ...extra] = value.slice(LIBSIGNAL_WIRE_PREFIX.length).split('.');
  const messageType = Number(rawType);
  if (extra.length || !encoded || !Number.isInteger(messageType) || messageType < 0 || messageType > 255) return null;
  try { return { messageType, ciphertext: new Uint8Array(base64ToBuffer(encoded)) }; } catch { return null; }
}

