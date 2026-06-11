/**
 * KDF Chain — Symmetric Ratchet
 * 
 * Each chain step derives a new chain key + message key from the previous chain key.
 * This provides forward secrecy at the message level: once a message key is used,
 * it cannot be recovered from the new chain key.
 * 
 * Chain:  CK₀ → CK₁ → CK₂ → ...
 * Keys:        MK₁,  MK₂, ...
 * 
 * CK_{n+1} = HMAC-SHA-256(CK_n, 0x02)
 * MK_n     = HMAC-SHA-256(CK_n, 0x01)
 */

import { AES_ALGO, AES_KEY_LENGTH } from './constants';
import { hardCrypto, hardGlobals } from './cryptoIntegrity';

/** Derive next chain key and message key from current chain key */
export async function kdfChainStep(chainKey: CryptoKey): Promise<{
  nextChainKey: CryptoKey;
  messageKey: CryptoKey;
}> {
  // Signal-style: use clean buffers with .slice() to avoid byteOffset issues
  const mkRaw = await hardCrypto.sign(
    'HMAC', chainKey, new Uint8Array([0x01]).slice().buffer
  );
  const ckRaw = await hardCrypto.sign(
    'HMAC', chainKey, new Uint8Array([0x02]).slice().buffer
  );

  const [messageKey, nextChainKey] = await Promise.all([
    hardCrypto.importKey(
      'raw', mkRaw.slice(0, 32),
      { name: AES_ALGO, length: AES_KEY_LENGTH },
      false, ['encrypt', 'decrypt']
    ),
    hardCrypto.importKey(
      'raw', ckRaw.slice(0, 32),
      { name: 'HMAC', hash: 'SHA-256', length: 256 } as any, true, ['sign']
    ),
  ]);

  return { nextChainKey, messageKey };
}

/** Same as kdfChainStep but message key is exportable (for skipped key storage) */
export async function kdfChainStepExportable(chainKey: CryptoKey): Promise<{
  nextChainKey: CryptoKey;
  messageKey: CryptoKey;
}> {
  const mkRaw = await hardCrypto.sign(
    'HMAC', chainKey, new Uint8Array([0x01]).slice().buffer
  );
  const ckRaw = await hardCrypto.sign(
    'HMAC', chainKey, new Uint8Array([0x02]).slice().buffer
  );

  const [messageKey, nextChainKey] = await Promise.all([
    hardCrypto.importKey(
      'raw', mkRaw.slice(0, 32),
      { name: AES_ALGO, length: AES_KEY_LENGTH },
      true, ['encrypt', 'decrypt']
    ),
    hardCrypto.importKey(
      'raw', ckRaw.slice(0, 32),
      { name: 'HMAC', hash: 'SHA-256', length: 256 } as any, true, ['sign']
    ),
  ]);

  return { nextChainKey, messageKey };
}

/** Import raw bytes as an HMAC chain key */
export async function importChainKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return hardCrypto.importKey(
    'raw', raw.slice(0, 32),
    { name: 'HMAC', hash: 'SHA-256', length: 256 } as any,
    true, ['sign']
  );
}

/** Perform a DH ratchet step: X25519 DH → HKDF → new root key + chain key */
export async function kdfRootStep(
  rootKey: CryptoKey,
  dhOutput: ArrayBuffer,
): Promise<{ newRootKey: CryptoKey; newChainKey: CryptoKey }> {
  const hkdfInput = await hardCrypto.importKey(
    'raw', dhOutput, 'HKDF', false, ['deriveBits']
  );

  const rootKeyRaw = await hardCrypto.exportKey('raw', rootKey);

  const derived = await hardCrypto.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: rootKeyRaw,
      info: new hardGlobals.TextEncoder().encode('ForSureRatchet'),
    },
    hkdfInput,
    512,
  );

  const [newRootKey, newChainKey] = await Promise.all([
    hardCrypto.importKey(
      'raw', derived.slice(0, 32),
      { name: 'HMAC', hash: 'SHA-256', length: 256 } as any,
      true, ['sign']
    ),
    hardCrypto.importKey(
      'raw', derived.slice(32, 64),
      { name: 'HMAC', hash: 'SHA-256', length: 256 } as any,
      true, ['sign']
    ),
  ]);

  return { newRootKey, newChainKey };
}
