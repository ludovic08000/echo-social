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
 * Future improvement: publish a dedicated per-device X25519 key (separate from
 * the shared identity key) and use it here. Until then, treat this path as
 * "shared-identity-bound" and keep the ratchet path as the source of truth.
 *
 * Format of the wrapped payload: base64(iv) "." base64(ciphertext)
 */
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { randomBytes, bufferToBase64, base64ToBuffer } from '@/lib/crypto/utils';
import { getOrCreateIdentityKeys } from '@/lib/crypto/keyManager';
import { KX_KEY_PARAMS } from '@/lib/crypto/constants';

const IV_LEN = 12;
const SEP = '.';

async function deriveAesKey(
  senderUserId: string,
  recipientDevicePublicKeyB64: string,
  recipientDeviceId: string,
): Promise<CryptoKey> {
  const identityKeys = await getOrCreateIdentityKeys(senderUserId);
  const peerRaw = base64ToBuffer(recipientDevicePublicKeyB64);
  const peerPub = await hardCrypto.importKey('raw', peerRaw, KX_KEY_PARAMS as any, true, []);

  const sharedBits = await hardCrypto.deriveBits(
    { name: 'X25519', public: peerPub } as any,
    identityKeys.privateKey,
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

export async function wrapPlaintextForDevice(
  plaintext: string,
  senderUserId: string,
  recipientDevicePublicKeyB64: string,
  recipientDeviceId: string,
): Promise<string> {
  const aes = await deriveAesKey(senderUserId, recipientDevicePublicKeyB64, recipientDeviceId);
  const iv = randomBytes(IV_LEN);
  const ct = await hardCrypto.encrypt(
    { name: 'AES-GCM', iv: iv as Uint8Array<ArrayBuffer>, tagLength: 128 },
    aes,
    new hardGlobals.TextEncoder().encode(plaintext),
  );
  return `${bufferToBase64(iv.buffer as ArrayBuffer)}${SEP}${bufferToBase64(ct as ArrayBuffer)}`;
}

export async function unwrapPlaintextForDevice(
  payload: string,
  recipientUserId: string,
  senderDevicePublicKeyB64: string,
  myDeviceId: string,
): Promise<string> {
  if (!payload.includes(SEP)) throw new Error('Invalid device-wrapped payload');
  const aes = await deriveAesKey(recipientUserId, senderDevicePublicKeyB64, myDeviceId);
  const [ivB64, ctB64] = payload.split(SEP);
  const iv = new Uint8Array(base64ToBuffer(ivB64));
  const ct = base64ToBuffer(ctB64);
  const pt = await hardCrypto.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    aes,
    ct,
  );
  return new hardGlobals.TextDecoder().decode(pt);
}
