import { hardCrypto } from './cryptoIntegrity';
import { bufferToBase64, encodeString } from './utils';

export interface DeviceEnrollmentPossessionStatement {
  challengeId: string;
  deviceId: string;
  nonceHash: string;
  expiresAt: string;
  accountFingerprint: string;
  devicePublicKey: string;
  deviceSigningKey: string;
}

function normalizeExpiry(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error('DEVICE_ENROLLMENT_INVALID_EXPIRY');
  }
  return new Date(timestamp).toISOString();
}

export async function hashDeviceEnrollmentNonce(nonce: string): Promise<string> {
  if (nonce.length < 32) throw new Error('DEVICE_ENROLLMENT_INVALID_NONCE');
  const digest = new Uint8Array(await hardCrypto.digest('SHA-256', encodeString(nonce)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalDeviceEnrollmentPossessionPayload(
  args: DeviceEnrollmentPossessionStatement,
): string {
  return JSON.stringify({
    protocol: 'forsure-aegis-device-possession',
    version: 1,
    challengeId: args.challengeId,
    deviceId: args.deviceId,
    nonceHash: args.nonceHash.toLowerCase(),
    expiresAt: normalizeExpiry(args.expiresAt),
    accountFingerprint: args.accountFingerprint,
    devicePublicKey: args.devicePublicKey,
    deviceSigningKey: args.deviceSigningKey,
  });
}

export async function signDeviceEnrollmentPossession(args: {
  challengeId: string;
  deviceId: string;
  nonce: string;
  expiresAt: string;
  accountFingerprint: string;
  devicePublicKey: string;
  deviceSigningKey: string;
  deviceSigningPrivateKey: CryptoKey;
}): Promise<string> {
  const nonceHash = await hashDeviceEnrollmentNonce(args.nonce);
  const payload = canonicalDeviceEnrollmentPossessionPayload({
    challengeId: args.challengeId,
    deviceId: args.deviceId,
    nonceHash,
    expiresAt: args.expiresAt,
    accountFingerprint: args.accountFingerprint,
    devicePublicKey: args.devicePublicKey,
    deviceSigningKey: args.deviceSigningKey,
  });

  return bufferToBase64(await hardCrypto.sign(
    'Ed25519',
    args.deviceSigningPrivateKey,
    encodeString(payload),
  ) as ArrayBuffer);
}
