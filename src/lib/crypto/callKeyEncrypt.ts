/**
 * Call key encryption — wraps the LiveKit E2EE session key
 * using the conversation's existing AES-256-GCM session key.
 *
 * The encrypted payload is stored in `active_calls.encrypted_call_key`.
 * The server NEVER sees the plaintext call key.
 * Only the two conversation participants (who share the session key)
 * can decrypt it locally at call-accept time.
 */

import { hardCrypto } from './cryptoIntegrity';
import { randomBytes, bufferToBase64, base64ToBuffer } from './utils';
import { loadSessionKey, deleteSessionKey, getOrCreateIdentityKeys } from './keyManager';
import { establishSession } from './e2ee';
import { supabase } from '@/integrations/supabase/client';

const IV_LEN = 12;
const ENCRYPTED_SEPARATOR = '.';

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

  const session = await loadSessionKey(conversationId);
  if (session?.sharedSecret && session.peerFingerprint === peerKey.fingerprint) {
    return session;
  }

  await deleteSessionKey(conversationId);
  const identityKeys = await getOrCreateIdentityKeys(localUserId);

  return establishSession(
    identityKeys,
    peerKey.identity_key,
    conversationId,
    peerKey.fingerprint,
  );
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
  const plaintext = new TextEncoder().encode(callKeyB64);

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
): Promise<string> {
  if (encryptedPayload.startsWith('raw:')) {
    throw new Error('[CALL_E2EE] Insecure raw call key payload rejected');
  }

  if (!encryptedPayload.includes(ENCRYPTED_SEPARATOR)) {
    throw new Error('[CALL_E2EE] Payload is not encrypted');
  }

  const session = await loadSessionKey(conversationId);
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

  return new TextDecoder().decode(plainBuf);
}
