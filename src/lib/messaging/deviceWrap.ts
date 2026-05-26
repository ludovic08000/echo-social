/**
 * Per-device plaintext wrap (multi-device E2EE fan-out) — FALLBACK ONLY.
 *
 * SECURITY: this fallback must never bypass a failed X3DH/SPK validation.
 * If a device is known invalid, wrapping to it is refused.
 */
import { hardCrypto, hardGlobals } from '@/lib/crypto/cryptoIntegrity';
import { randomBytes, bufferToBase64, base64ToBuffer, importOkpPublicKeyFromBase64 } from '@/lib/crypto/utils';
import { getOrCreateIdentityKeys } from '@/lib/crypto/keyManager';
import { loadDeviceKxKey } from '@/lib/crypto/deviceKx';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { isInvalidDeviceId } from '@/lib/crypto/invalidDeviceCache';

const IV_LEN = 12;
const SEP = '.';

async function deriveAesKeyWith(
  myPrivateKx: CryptoKey,
  peerPublicKxB64: string,
  recipientDeviceId: string,
): Promise<CryptoKey> {
  const peerPub = await importOkpPublicKeyFromBase64(peerPublicKxB64, 'X25519', [], true);
  const sharedBits = await hardCrypto.deriveBits({ name: 'X25519', public: peerPub } as any, myPrivateKx, 256);
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
  if (isInvalidDeviceId(recipientDeviceId)) {
    throw new Error('DEVICE_WRAP_REFUSED_INVALID_DEVICE');
  }

  const myDeviceId = getCurrentDeviceId();
  let aes: CryptoKey | null = null;

  try {
    const myKx = await loadDeviceKxKey(myDeviceId);
    if (myKx?.privateKey) aes = await deriveAesKeyWith(myKx.privateKey, recipientDevicePublicKeyB64, recipientDeviceId);
  } catch {}

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
    if (senderLegacyIdentityKeyB64) candidates.push({ priv: myKx.privateKey, peerPubB64: senderLegacyIdentityKeyB64 });
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
