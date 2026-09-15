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

// Invariant cryptographique : le seul fil de capsule d'appareil est libsignal.
// Type 2 = message Signal (ratchet), type 3 = PreKeySignalMessage (init).
export const VALID_RATCHET_COPY = `aegis.libsignal.2.${bytes(48, 7)}`;
export const VALID_INIT_COPY = `aegis.libsignal.3.${bytes(64, 11)}`;
