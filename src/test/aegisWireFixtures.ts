import { bufferToBase64 } from '@/lib/crypto/utils';

function bytes(length: number, seed: number): string {
  const value = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) value[index] = (seed + index) & 0xff;
  return bufferToBase64(value.buffer as ArrayBuffer);
}

export const VALID_AEGIS_SESSION_ID = 's_AAAAAAAAAAAAAAAAAAAAAA';
export const VALID_X25519_KEY = bytes(32, 1);
export const VALID_X25519_KEY_2 = bytes(32, 33);
export const VALID_IV = bytes(12, 70);
export const VALID_CIPHERTEXT = bytes(32, 90);
export const VALID_TAG = bytes(32, 130);

export const VALID_RATCHET_COPY = [
  `aegis1.ratchet.${VALID_AEGIS_SESSION_ID}`,
  VALID_X25519_KEY,
  '0',
  '0',
  VALID_IV,
  VALID_CIPHERTEXT,
].join('.');

const innerB64 = bufferToBase64(
  new TextEncoder().encode(VALID_RATCHET_COPY).buffer as ArrayBuffer,
);

export const VALID_INIT_COPY = [
  `aegis1.init.v1.${VALID_AEGIS_SESSION_ID}`,
  VALID_X25519_KEY_2,
  '17',
  '23',
  VALID_X25519_KEY,
  VALID_X25519_KEY_2,
  innerB64,
  VALID_TAG,
].join('.');
