/**
 * Call key encryption — wraps the LiveKit E2EE session key so the server
 * never sees the plaintext call key; only the two participants can decrypt it.
 *
 * The encrypted payload is stored in `active_calls.encrypted_call_key`.
 *
 * ── Forward secrecy (audit N3) ─────────────────────────────────────────────
 * v2 wire (`c2.<ephPub>.<iv>.<ct>`) wraps the call key with an EPHEMERAL
 * X25519 keypair: shared = ECDH(ephemeralPriv, peerIdentityPub) on the sender,
 * and ECDH(myIdentityPriv, ephemeralPub) on the recipient (DH symmetry). The
 * sender discards the ephemeral private key, so a later compromise of the
 * sender's identity key cannot recover past call keys (sender-side forward
 * secrecy — a strict improvement over the previous static identity DH).
 * Full two-sided PFS would require a Double-Ratchet round-trip; calls are a
 * one-shot offline push, so ephemeral-static ECIES is the pragmatic choice.
 *
 * Legacy wire (`<iv>.<ct>`) is still accepted on decrypt for interop.
 */

import { hardCrypto, hardGlobals } from './cryptoIntegrity';
import {
  randomBytes,
  bufferToBase64,
  base64ToBuffer,
  importOkpPublicKeyFromBase64,
} from './utils';
import { loadSessionKey, getOrCreateIdentityKeys, exportPublicKeyRaw } from './keyManager';
import { supabase } from '@/integrations/supabase/client';

const IV_LEN = 12;
const ENCRYPTED_SEPARATOR = '.';
const WIRE_V2 = 'c2';

/** HKDF-SHA-256 → AES-256-GCM key, deterministic per conversation. */
async function deriveCallAesKey(sharedBits: ArrayBuffer, conversationId: string): Promise<CryptoKey> {
  const saltSource = new hardGlobals.TextEncoder().encode(`forsure-call-salt-${conversationId}`);
  const salt = new Uint8Array(await hardCrypto.digest('SHA-256', saltSource)) as Uint8Array<ArrayBuffer>;
  const info = new hardGlobals.TextEncoder().encode(`forsure-call-key-${conversationId}`);
  const hkdfKey = await hardCrypto.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return hardCrypto.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function fetchPeerIdentityPub(peerUserId: string): Promise<CryptoKey> {
  const { data: peerKey } = await supabase
    .from('user_public_keys')
    .select('identity_key, fingerprint')
    .eq('user_id', peerUserId)
    .eq('is_active', true)
    .maybeSingle();
  if (!peerKey?.identity_key) {
    throw new Error('No active peer identity key for this conversation');
  }
  return importOkpPublicKeyFromBase64(peerKey.identity_key, 'X25519', [], true);
}

/**
 * LEGACY static-DH session (forward-secrecy-less). Kept only so a v2 client
 * can still DECRYPT a legacy `<iv>.<ct>` payload during rollout.
 */
async function ensureFreshCallSession(
  conversationId: string,
  localUserId: string,
  peerUserId: string,
) {
  const peerPub = await fetchPeerIdentityPub(peerUserId);
  const identityKeys = await getOrCreateIdentityKeys(localUserId);
  const sharedBits = await hardCrypto.deriveBits(
    { name: 'X25519', public: peerPub } as any,
    identityKeys.privateKey,
    256,
  );
  return deriveCallAesKey(sharedBits, conversationId);
}

/**
 * Encrypt a call E2EE key. With both user ids, uses the forward-secret v2
 * (ephemeral) path. Returns `c2.<ephPub>.<iv>.<ct>` (all base64).
 */
export async function encryptCallKey(
  callKeyB64: string,
  conversationId: string,
  localUserId?: string,
  peerUserId?: string,
): Promise<string> {
  const plaintext = new hardGlobals.TextEncoder().encode(callKeyB64);
  const iv = randomBytes(IV_LEN);

  if (localUserId && peerUserId) {
    // v2 — ephemeral-static ECIES (forward secrecy on the sender side).
    const peerPub = await fetchPeerIdentityPub(peerUserId);
    const eph = await hardCrypto.generateKey({ name: 'X25519' } as any, true, ['deriveBits']) as CryptoKeyPair;
    const ephPubRaw = await exportPublicKeyRaw(eph.publicKey);
    const sharedBits = await hardCrypto.deriveBits(
      { name: 'X25519', public: peerPub } as any,
      eph.privateKey,
      256,
    );
    const aesKey = await deriveCallAesKey(sharedBits, conversationId);
    const ciphertext = await hardCrypto.encrypt(
      { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
      aesKey,
      plaintext,
    );
    return [
      WIRE_V2,
      bufferToBase64(ephPubRaw),
      bufferToBase64(iv.buffer as ArrayBuffer),
      bufferToBase64(ciphertext as ArrayBuffer),
    ].join(ENCRYPTED_SEPARATOR);
  }

  // Fallback (no ids): legacy cached static session.
  const session = await loadSessionKey(conversationId);
  if (!session?.sharedSecret) {
    throw new Error('No E2EE session for this conversation');
  }
  const ciphertext = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
    session.sharedSecret,
    plaintext,
  );
  return `${bufferToBase64(iv.buffer as ArrayBuffer)}${ENCRYPTED_SEPARATOR}${bufferToBase64(ciphertext as ArrayBuffer)}`;
}

/**
 * Decrypt a call E2EE key. Handles v2 (ephemeral) and legacy payloads.
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

  const parts = encryptedPayload.split(ENCRYPTED_SEPARATOR);

  // v2 — ephemeral path: c2.<ephPub>.<iv>.<ct>
  if (parts[0] === WIRE_V2 && parts.length === 4) {
    if (!localUserId) {
      throw new Error('[CALL_E2EE] Missing local user id to decrypt v2 call key');
    }
    const [, ephPubB64, ivB64, ctB64] = parts;
    const identityKeys = await getOrCreateIdentityKeys(localUserId);
    const ephPub = await importOkpPublicKeyFromBase64(ephPubB64, 'X25519', [], true);
    const sharedBits = await hardCrypto.deriveBits(
      { name: 'X25519', public: ephPub } as any,
      identityKeys.privateKey,
      256,
    );
    const aesKey = await deriveCallAesKey(sharedBits, conversationId);
    const plainBuf = await hardCrypto.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(ivB64)), tagLength: 128 },
      aesKey,
      base64ToBuffer(ctB64),
    );
    return new hardGlobals.TextDecoder().decode(plainBuf);
  }

  // Legacy path: <iv>.<ct>
  if (parts.length !== 2) {
    throw new Error('[CALL_E2EE] Payload is not encrypted');
  }
  const session = localUserId && peerUserId
    ? await ensureFreshCallSession(conversationId, localUserId, peerUserId)
    : (await loadSessionKey(conversationId))?.sharedSecret;
  if (!session) {
    throw new Error('No E2EE session key to decrypt call key');
  }
  const [ivB64, ctB64] = parts;
  const plainBuf = await hardCrypto.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(ivB64)), tagLength: 128 },
    session,
    base64ToBuffer(ctB64),
  );
  return new hardGlobals.TextDecoder().decode(plainBuf);
}
