/**
 * Call key encryption — wraps the LiveKit E2EE session key
 * using the conversation's existing AES-256-GCM session key.
 *
 * The encrypted payload is stored in `active_calls.encrypted_call_key`.
 * The server NEVER sees the plaintext call key.
 * Only the two conversation participants (who share the session key)
 * can decrypt it locally at call-accept time.
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import { randomBytes, bufferToBase64, base64ToBuffer, encodeString, decodeString, importKeyFromJWK } from './utils';
import { loadSessionKey, getOrCreateIdentityKeys } from './keyManager';
import { supabase } from '@/integrations/supabase/client';
import { KX_KEY_PARAMS } from './constants';

const IV_LEN = 12;
const ENCRYPTED_SEPARATOR = '.';

/**
 * ALWAYS re-derive a fresh ECDH session for call key operations.
 * Unlike messaging (where sessions are cached), call key crypto
 * must be 100% in sync between caller and callee at the exact
 * moment of the call — so we never trust cached sessions.
 */
async function ensureFreshCallSession(
  conversationId: string,
  localUserId: string,
  peerUserId: string,
) {
  const { data: peerKey } = await supabase
    .from('user_public_keys')
    .select('identity_key, fingerprint')
    .eq('user_id', peerUserId)
    .eq('is_active', true)
    .maybeSingle();

  if (!peerKey?.identity_key || !peerKey.fingerprint) {
    throw new Error('No active peer identity key for this conversation');
  }

  // Always derive fresh — never trust cached session for calls
  const identityKeys = await getOrCreateIdentityKeys(localUserId);

  // Derive shared secret from current key material (both sides)
  let peerPub: CryptoKey;
  try {
    const peerRaw = base64ToBuffer(peerKey.identity_key);
    peerPub = await hardCrypto.importKey('raw', peerRaw, KX_KEY_PARAMS as any, true, []);
  } catch {
    const x = peerKey.identity_key.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    peerPub = await importKeyFromJWK({ kty: 'OKP', crv: 'X25519', x }, KX_KEY_PARAMS as any, [], true);
  }

  const sharedBits = await hardCrypto.deriveBits(
    { name: 'X25519', public: peerPub } as any,
    identityKeys.privateKey,
    256,
  );

  const saltSource = new hardGlobals.TextEncoder().encode(`forsure-call-salt-${conversationId}`);
  const salt = new Uint8Array(await hardCrypto.digest('SHA-256', saltSource)) as Uint8Array<ArrayBuffer>;
  const info = new hardGlobals.TextEncoder().encode(`forsure-call-key-${conversationId}`);

  const hkdfKey = await hardCrypto.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);

  const aesKey = await hardCrypto.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  return {
    conversationId,
    sharedSecret: aesKey,
    messageCount: 0,
    createdAt: Date.now(),
    peerFingerprint: peerKey.fingerprint,
  };
}

/**
 * Encrypt a call E2EE key using the conversation's shared session key.
 * Returns a compact string: `iv.ciphertext` (both base64).
 * Throws if no session key exists — caller must handle gracefully.
 */
export async function encryptCallKey(
  callKeyB64: string,
  conversationId: string,
  localUserId?: string,
  peerUserId?: string,
): Promise<string> {
  const session = localUserId && peerUserId
    ? await ensureFreshCallSession(conversationId, localUserId, peerUserId)
    : await loadSessionKey(conversationId);
  if (!session?.sharedSecret) {
    throw new Error('No E2EE session for this conversation');
  }

  const iv = randomBytes(IV_LEN);
  const plaintext = new hardGlobals.TextEncoder().encode(callKeyB64);

  const ciphertext = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
    session.sharedSecret,
    plaintext,
  );

  return `${bufferToBase64(iv.buffer as ArrayBuffer)}${ENCRYPTED_SEPARATOR}${bufferToBase64(ciphertext as ArrayBuffer)}`;
}

/**
 * Decrypt a call E2EE key received via signaling.
 * Throws on failure — caller decides the fallback behaviour.
 */
export async function decryptCallKey(
  encryptedPayload: string,
  conversationId: string,
  localUserId?: string,
  peerUserId?: string,
): Promise<string> {
  if (encryptedPayload.startsWith('raw:')) {
    throw new Error('[CALL_E2EE] Insecure raw call key payload rejected');
  }

  if (!encryptedPayload.includes(ENCRYPTED_SEPARATOR)) {
    throw new Error('[CALL_E2EE] Payload is not encrypted');
  }

  // Always force fresh session derivation to ensure key sync
  const session = localUserId && peerUserId
    ? await ensureFreshCallSession(conversationId, localUserId, peerUserId)
    : await loadSessionKey(conversationId);
  if (!session?.sharedSecret) {
    throw new Error('No E2EE session key to decrypt call key');
  }

  const [ivB64, ctB64] = encryptedPayload.split(ENCRYPTED_SEPARATOR);
  const iv = new Uint8Array(base64ToBuffer(ivB64));
  const ciphertext = base64ToBuffer(ctB64);

  const plainBuf = await hardCrypto.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    session.sharedSecret,
    ciphertext,
  );

  return new hardGlobals.TextDecoder().decode(plainBuf);
}
