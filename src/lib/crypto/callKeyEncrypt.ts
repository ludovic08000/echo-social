/**
 * Call key encryption — wraps the LiveKit E2EE session key
 * using the conversation's existing AES-256-GCM session key.
 *
 * This ensures the key stored in `active_calls.e2ee_key` is
 * never readable by the server; only the two conversation
 * participants who share the session key can decrypt it.
 */

import { hardCrypto } from './cryptoIntegrity';
import { randomBytes, bufferToBase64, base64ToBuffer } from './utils';
import { loadSessionKey } from './keyManager';

const IV_LEN = 12;

/**
 * Encrypt a call E2EE key using the conversation's shared session key.
 * Returns a compact string: `iv.ciphertext` (both base64).
 * Falls back to plaintext if no session key exists (unencrypted conversations).
 */
export async function encryptCallKey(
  callKeyB64: string,
  conversationId: string,
): Promise<string> {
  const session = await loadSessionKey(conversationId);
  if (!session?.sharedSecret) {
    // No E2EE session for this conversation — send as-is (graceful fallback)
    return callKeyB64;
  }

  const iv = randomBytes(IV_LEN);
  const plaintext = new TextEncoder().encode(callKeyB64);

  const ciphertext = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
    session.sharedSecret,
    plaintext,
  );

  return `${bufferToBase64(iv.buffer as ArrayBuffer)}.${bufferToBase64(ciphertext as ArrayBuffer)}`;
}

/**
 * Decrypt a call E2EE key received via signaling.
 * If the value doesn't contain a dot separator, treat it as plain (legacy/fallback).
 */
export async function decryptCallKey(
  encryptedPayload: string,
  conversationId: string,
): Promise<string> {
  if (!encryptedPayload.includes('.')) {
    // Legacy plaintext key
    return encryptedPayload;
  }

  const session = await loadSessionKey(conversationId);
  if (!session?.sharedSecret) {
    console.warn('[CallKeyEncrypt] No session key to decrypt call key');
    // Return raw — useCall will try to use it anyway
    return encryptedPayload;
  }

  const [ivB64, ctB64] = encryptedPayload.split('.');
  const iv = new Uint8Array(base64ToBuffer(ivB64));
  const ciphertext = base64ToBuffer(ctB64);

  const plainBuf = await hardCrypto.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    session.sharedSecret,
    ciphertext,
  );

  return new TextDecoder().decode(plainBuf);
}
