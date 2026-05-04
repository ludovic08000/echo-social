/**
 * Per-device plaintext wrap (multi-device E2EE fan-out) — FALLBACK ONLY.
 *
 * ⚠️ SECURITY DESIGN NOTICE (audit 2026-04):
 * In the current hybrid model, `user_devices.device_public_key` is published as
 * the user's SHARED identityKey (see useDeviceRegistration). As a consequence,
 * this wrap mechanism does NOT provide true per-device cryptographic isolation:
 * all devices of the same user derive ECDH from the same identity key pair.
 * The `recipientDeviceId` is mixed into HKDF salt+info, which gives per-device
 * key separation at the symmetric layer, but if the shared identity private key
 * is ever compromised, every device fallback channel is compromised together.
 *
 * Primary path remains the per-device Double Ratchet (X3DH per device + ratchet
 * state per device), which DOES provide per-device isolation and forward secrecy.
 * `deviceWrap` is only used as a fallback when no ratchet session is available
 * yet (e.g. first message to a freshly linked device).
 *
 * Current preferred path: publish a dedicated per-device X25519 key (separate
 * from the shared identity key) and use it here. Legacy devices can still
 * decrypt old identity-bound wraps during the rolling migration window.
 *
 * Format of the wrapped payload: base64(iv) "." base64(ciphertext)
 */
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { randomBytes, bufferToBase64, base64ToBuffer, importOkpPublicKeyFromBase64 } from '@/lib/crypto/utils';
import { getOrCreateIdentityKeys } from '@/lib/crypto/keyManager';
import { loadDeviceKxKey, getOrCreateDeviceKxKey } from '@/lib/crypto/deviceKx';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';

const IV_LEN = 12;
const SEP = '.';

/**
 * Derive an AES-256-GCM key by ECDH between OUR private kx key and the peer's
 * public kx key, salted+info'd with the recipient device id (HKDF SHA-256).
 *
 * `myPrivateKx` lets the caller choose between:
 *   - the per-device dedicated kx key (preferred, true per-device isolation)
 *   - the shared identity key (legacy fallback for devices that haven't
 *     migrated yet, or for messages that were originally wrapped against the
 *     identity key).
 */
async function deriveAesKeyWith(
  myPrivateKx: CryptoKey,
  peerPublicKxB64: string,
  recipientDeviceId: string,
): Promise<CryptoKey> {
  const peerPub = await importOkpPublicKeyFromBase64(peerPublicKxB64, 'X25519', [], true);

  const sharedBits = await hardCrypto.deriveBits(
    { name: 'X25519', public: peerPub } as any,
    myPrivateKx,
    256,
  );

  const saltSrc = new hardGlobals.TextEncoder().encode(`forsure-mdc-salt-${recipientDeviceId}`);
  const salt = new Uint8Array(await hardCrypto.digest('SHA-256', saltSrc));
  const info = new hardGlobals.TextEncoder().encode(`forsure-mdc-${recipientDeviceId}`);

  const hkdfKey = await hardCrypto.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return hardCrypto.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt plaintext for a recipient device.
 *
 * Preferred path: derives ECDH from THIS device's dedicated kx key against the
 * recipient device's published `device_public_key`. Both sides must have a
 * dedicated kx key for this to succeed — the recipient device public key is
 * already the dedicated one if its owner has logged in since the migration.
 *
 * Legacy path: if no per-device kx key exists locally, falls back to the
 * sender's shared identity key (old behaviour). This keeps the function safe
 * during the rolling migration window.
 */
export async function wrapPlaintextForDevice(
  plaintext: string,
  senderUserId: string,
  recipientDevicePublicKeyB64: string,
  recipientDeviceId: string,
): Promise<string> {
  const myDeviceId = getCurrentDeviceId();

  // 1) Preferred: dedicated per-device kx key
  let aes: CryptoKey | null = null;
  try {
    const myKx = await loadDeviceKxKey(myDeviceId);
    if (myKx?.privateKey) {
      aes = await deriveAesKeyWith(myKx.privateKey, recipientDevicePublicKeyB64, recipientDeviceId);
    }
  } catch {
    /* fall through to legacy */
  }

  // 2) Legacy fallback: shared identity key (still works for non-migrated devices)
  if (!aes) {
    const identityKeys = await getOrCreateIdentityKeys(senderUserId);
    aes = await deriveAesKeyWith(identityKeys.privateKey, recipientDevicePublicKeyB64, recipientDeviceId);
  }

  const iv = randomBytes(IV_LEN);
  const ct = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
    aes,
    new hardGlobals.TextEncoder().encode(plaintext),
  );
  return `${bufferToBase64(iv.buffer as ArrayBuffer)}${SEP}${bufferToBase64(ct as ArrayBuffer)}`;
}

/**
 * Decrypt a payload addressed to THIS device.
 *
 * Tries every (myPrivKey, senderPubKey) combination across the migration:
 *   - my dedicated device kx  ↔  sender's current device_public_key
 *   - my dedicated device kx  ↔  sender's legacy identity public key
 *   - my shared identity key  ↔  sender's current device_public_key
 *   - my shared identity key  ↔  sender's legacy identity public key
 *
 * AES-GCM auth-tag failures throw; we swallow each and try the next candidate.
 *
 * @param senderLegacyIdentityKeyB64 Optional sender identity pub (used to read
 *   messages wrapped before the sender migrated to a dedicated device kx key).
 */
export async function unwrapPlaintextForDevice(
  payload: string,
  recipientUserId: string,
  senderDevicePublicKeyB64: string,
  myDeviceId: string,
  senderLegacyIdentityKeyB64?: string | null,
): Promise<string> {
  if (!payload.includes(SEP)) throw new Error('Invalid device-wrapped payload');
  const [ivB64, ctB64] = payload.split(SEP);
  const iv = new Uint8Array(base64ToBuffer(ivB64));
  const ct = base64ToBuffer(ctB64);

  const myKx = await loadDeviceKxKey(myDeviceId);
  const identityKeys = await getOrCreateIdentityKeys(recipientUserId);

  const candidates: Array<{ priv: CryptoKey; peerPubB64: string }> = [];
  if (myKx?.privateKey) {
    candidates.push({ priv: myKx.privateKey, peerPubB64: senderDevicePublicKeyB64 });
    if (senderLegacyIdentityKeyB64) {
      candidates.push({ priv: myKx.privateKey, peerPubB64: senderLegacyIdentityKeyB64 });
    }
  }
  candidates.push({ priv: identityKeys.privateKey, peerPubB64: senderDevicePublicKeyB64 });
  if (senderLegacyIdentityKeyB64 && senderLegacyIdentityKeyB64 !== senderDevicePublicKeyB64) {
    candidates.push({ priv: identityKeys.privateKey, peerPubB64: senderLegacyIdentityKeyB64 });
  }

  let lastErr: unknown = null;
  for (const c of candidates) {
    try {
      const aes = await deriveAesKeyWith(c.priv, c.peerPubB64, myDeviceId);
      const pt = await hardCrypto.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, aes, ct);
      return new hardGlobals.TextDecoder().decode(pt);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('deviceWrap: all decryption candidates failed');
}
