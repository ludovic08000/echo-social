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

/** Derive next chain key and message key from current chain key */
export async function kdfChainStep(chainKey: CryptoKey): Promise<{
  nextChainKey: CryptoKey;
  messageKey: CryptoKey;
}> {
  // Message key: HMAC(chainKey, 0x01)
  const mkRaw = await crypto.subtle.sign(
    'HMAC', chainKey, new Uint8Array([0x01]).buffer
  );

  // Next chain key: HMAC(chainKey, 0x02)
  const ckRaw = await crypto.subtle.sign(
    'HMAC', chainKey, new Uint8Array([0x02]).buffer
  );

  const [messageKey, nextChainKey] = await Promise.all([
    crypto.subtle.importKey(
      'raw', mkRaw.slice(0, 32),
      { name: AES_ALGO, length: AES_KEY_LENGTH },
      false, ['encrypt', 'decrypt']  // non-exportable — used once then discarded
    ),
    crypto.subtle.importKey(
      'raw', ckRaw.slice(0, 32),
      'HMAC', true, ['sign']  // exportable — needs serialization for ratchet persistence
    ),
  ]);

  return { nextChainKey, messageKey };
}

/** Import raw bytes as an HMAC chain key */
export async function importChainKey(raw: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey(
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
  // Import DH output as HKDF input
  const hkdfInput = await crypto.subtle.importKey(
    'raw', dhOutput, 'HKDF', false, ['deriveBits']
  );

  // Export root key as salt
  const rootKeyRaw = await crypto.subtle.exportKey('raw', rootKey);

  // Derive 64 bytes: first 32 = new root key, last 32 = new chain key
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: rootKeyRaw,
      info: new TextEncoder().encode('ForSureRatchet'),
    },
    hkdfInput,
    512, // 64 bytes
  );

  const [newRootKey, newChainKey] = await Promise.all([
    crypto.subtle.importKey(
      'raw', derived.slice(0, 32),
      { name: 'HMAC', hash: 'SHA-256', length: 256 } as any,
      true, ['sign']  // exportable — needs serialization for ratchet persistence
    ),
    crypto.subtle.importKey(
      'raw', derived.slice(32, 64),
      { name: 'HMAC', hash: 'SHA-256', length: 256 } as any,
      true, ['sign']  // exportable — needs serialization for ratchet persistence
    ),
  ]);

  return { newRootKey, newChainKey };
}
