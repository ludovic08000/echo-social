/**
 * Per-device plaintext wrap (multi-device E2EE fan-out).
 *
 * Each recipient device has its own X25519 public key (`user_devices.device_public_key`).
 * To distribute a message to N devices, we ECDH-wrap the same plaintext N times,
 * once per device, using HKDF(ECDH) → AES-256-GCM.
 *
 * This NEVER replaces the per-conversation Double Ratchet — it only adds an
 * additional, addressable copy per device so that a user reading on a second
 * device (where the ratchet state does not exist) can still see the message.
 *
 * Format of the wrapped payload: base64(iv) "." base64(ciphertext)
 * (Same shape as callKeyEncrypt — keeps payload compact.)
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
