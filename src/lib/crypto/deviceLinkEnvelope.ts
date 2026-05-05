import { base64ToBuffer, bufferToBase64, importKeyFromJWK } from './utils';

export const DEVICE_LINK_QR_TYPE = 'forsure.linked-device.request';
export const DEVICE_LINK_ENVELOPE_ALG = 'ECDH-P256-HKDF-SHA256-AES256GCM';

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };
const HKDF_INFO = new TextEncoder().encode('forsure-device-link-v2');

export interface DeviceLinkKeyPair {
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
}

export interface DeviceLinkQrPayload {
  v: 2;
  type: typeof DEVICE_LINK_QR_TYPE;
  t: string;
}

export interface DeviceLinkTransferEnvelope {
  v: 2;
  alg: typeof DEVICE_LINK_ENVELOPE_ALG;
  senderPublicJwk: JsonWebKey;
  salt: string;
  iv: string;
  ct: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  const b64 = bufferToBase64(bytes.buffer as ArrayBuffer);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function hexFromBuffer(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function assertP256Jwk(jwk: JsonWebKey, role: 'public' | 'private'): void {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error(`Invalid linked-device ${role} key`);
  }
  if (role === 'private' && typeof jwk.d !== 'string') {
    throw new Error('Invalid linked-device private key');
  }
}

async function importPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  assertP256Jwk(jwk, 'public');
  return importKeyFromJWK(jwk, ECDH_PARAMS, [], false);
}

async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  assertP256Jwk(jwk, 'private');
  return importKeyFromJWK(jwk, ECDH_PARAMS, ['deriveBits'], false);
}

async function deriveTransferKey(
  privateKey: CryptoKey,
  peerPublicJwk: JsonWebKey,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const peerPublicKey = await importPublicKey(peerPublicJwk);
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: HKDF_INFO },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function generateDeviceLinkToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64Url(bytes);
}

export async function hashDeviceLinkToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return hexFromBuffer(digest);
}

export function buildDeviceLinkQrData(token: string): string {
  const payload: DeviceLinkQrPayload = {
    v: 2,
    type: DEVICE_LINK_QR_TYPE,
    t: token,
  };
  return JSON.stringify(payload);
}

export function parseDeviceLinkToken(qrData: string): string {
  const raw = qrData.trim();
  if (!raw) throw new Error('Code de liaison vide');

  try {
    const parsed = JSON.parse(raw) as Partial<DeviceLinkQrPayload> & { token?: unknown };
    const token = typeof parsed.t === 'string' ? parsed.t : typeof parsed.token === 'string' ? parsed.token : '';
    if (token) return token;
  } catch {
    // Plain token fallback for copy/paste flows.
  }

  if (/^[A-Za-z0-9_-]{32,}$/.test(raw)) return raw;
  throw new Error('Code de liaison invalide');
}

export async function generateDeviceLinkKeyPair(): Promise<DeviceLinkKeyPair> {
  const pair = await crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveBits']);
  const { publicKey, privateKey } = pair as CryptoKeyPair;
  const [publicJwk, privateJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', publicKey),
    crypto.subtle.exportKey('jwk', privateKey),
  ]);
  assertP256Jwk(publicJwk, 'public');
  assertP256Jwk(privateJwk, 'private');
  return { publicJwk, privateJwk };
}

export async function encryptDeviceLinkPayload(
  plaintext: string,
  requesterPublicJwk: JsonWebKey,
): Promise<DeviceLinkTransferEnvelope> {
  const senderPair = await crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveBits']);
  const { publicKey, privateKey } = senderPair as CryptoKeyPair;
  const senderPublicJwk = await crypto.subtle.exportKey('jwk', publicKey);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveTransferKey(privateKey, requesterPublicJwk, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );

  return {
    v: 2,
    alg: DEVICE_LINK_ENVELOPE_ALG,
    senderPublicJwk,
    salt: bufferToBase64(salt.buffer),
    iv: bufferToBase64(iv.buffer),
    ct: bufferToBase64(ct),
  };
}

export async function decryptDeviceLinkPayload(
  envelope: DeviceLinkTransferEnvelope,
  requesterPrivateJwk: JsonWebKey,
): Promise<string> {
  if (envelope?.v !== 2 || envelope.alg !== DEVICE_LINK_ENVELOPE_ALG) {
    throw new Error('Format de transfert non supporte');
  }
  const privateKey = await importPrivateKey(requesterPrivateJwk);
  const salt = new Uint8Array(base64ToBuffer(envelope.salt));
  const iv = new Uint8Array(base64ToBuffer(envelope.iv));
  const key = await deriveTransferKey(privateKey, envelope.senderPublicJwk, salt);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    base64ToBuffer(envelope.ct),
  );
  return new TextDecoder().decode(plain);
}
