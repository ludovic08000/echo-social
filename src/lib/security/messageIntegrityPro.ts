import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { bufferToBase64 } from '@/lib/crypto/utils';

export async function sha256(data){
  const enc = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  return bufferToBase64(hash);
}

export async function computeSignedHash(prevHash, message, privateKey){
  const payload = prevHash + JSON.stringify(message);
  const hash = await sha256(payload);
  const signature = await hardCrypto.sign('Ed25519', privateKey, new TextEncoder().encode(hash));
  return { hash, signature: bufferToBase64(signature) };
}
