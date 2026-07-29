import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION,
  getOrCreateDeviceIdentity,
  signDeviceIdentityBinding,
  verifyDeviceIdentityBinding,
} from '@/lib/crypto/deviceIdentity';
import { bufferToBase64 } from '@/lib/crypto/utils';

async function exportRaw(key: CryptoKey): Promise<string> {
  return bufferToBase64(await crypto.subtle.exportKey('raw', key) as ArrayBuffer);
}

describe('account-authorized Sesame devices', () => {
  it('rejects a valid device self-signature unless the account key authorizes it', async () => {
    const device = await getOrCreateDeviceIdentity('user-v2', 'device-v2');
    const account = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const attacker = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const devicePublicKey = bufferToBase64(new Uint8Array(32).fill(9).buffer as ArrayBuffer);
    const signature = await signDeviceIdentityBinding({
      userId: 'user-v2',
      deviceId: 'device-v2',
      devicePublicKey,
      identity: device,
      accountSigningPrivateKey: account.privateKey,
      identityVersion: ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION,
    });

    expect(await verifyDeviceIdentityBinding({
      userId: 'user-v2',
      deviceId: 'device-v2',
      devicePublicKey,
      signingPublicKey: device.publicB64,
      signature,
      identityVersion: ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION,
      accountSigningPublicKey: await exportRaw(account.publicKey),
    })).toBe(true);

    expect(await verifyDeviceIdentityBinding({
      userId: 'user-v2',
      deviceId: 'device-v2',
      devicePublicKey,
      signingPublicKey: device.publicB64,
      signature,
      identityVersion: ACCOUNT_AUTHORIZED_DEVICE_IDENTITY_VERSION,
      accountSigningPublicKey: await exportRaw(attacker.publicKey),
    })).toBe(false);
  });
});
