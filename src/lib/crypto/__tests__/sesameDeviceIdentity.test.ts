import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  canonicalDeviceAuthorizationPayload,
  getOrCreateDeviceIdentity,
  signDeviceAuthorization,
  verifyDeviceAuthorization,
} from '../deviceIdentity';
import { bufferToBase64 } from '../utils';

async function accountSigningPair(): Promise<{ publicB64: string; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'Ed25519' } as Algorithm,
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  return {
    publicB64: bufferToBase64(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer),
    privateKey: pair.privateKey,
  };
}

describe('account-authorized device identity', () => {
  it('requires the stable account key to authorize the device KX and signing keys', async () => {
    const userId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const account = await accountSigningPair();
    const device = await getOrCreateDeviceIdentity(userId, deviceId);
    const devicePublicKey = bufferToBase64(crypto.getRandomValues(new Uint8Array(32)).buffer);
    const accountFingerprint = 'ab'.repeat(32);
    const authorizationSignature = await signDeviceAuthorization({
      userId,
      deviceId,
      accountFingerprint,
      devicePublicKey,
      deviceSigningKey: device.publicB64,
      accountSigningPrivateKey: account.privateKey,
    });

    await expect(verifyDeviceAuthorization({
      userId,
      deviceId,
      accountFingerprint,
      accountSigningKey: account.publicB64,
      devicePublicKey,
      deviceSigningKey: device.publicB64,
      authorizationSignature,
    })).resolves.toBe(true);
    await expect(verifyDeviceAuthorization({
      userId,
      deviceId: crypto.randomUUID(),
      accountFingerprint,
      accountSigningKey: account.publicB64,
      devicePublicKey,
      deviceSigningKey: device.publicB64,
      authorizationSignature,
    })).resolves.toBe(false);
  });

  it('uses one unambiguous canonical authorization payload without a self-signed version branch', () => {
    expect(canonicalDeviceAuthorizationPayload({
      userId: 'u',
      deviceId: 'd',
      accountFingerprint: 'fp',
      devicePublicKey: 'kx',
      deviceSigningKey: 'sig',
    })).toBe(
      '{"protocol":"forsure-aegis-device-authorization","userId":"u","deviceId":"d","accountFingerprint":"fp","devicePublicKey":"kx","deviceSigningKey":"sig"}',
    );
  });
});
