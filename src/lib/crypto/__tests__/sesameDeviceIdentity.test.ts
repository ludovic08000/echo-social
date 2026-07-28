import { describe, expect, it } from 'vitest';
import {
  canonicalDeviceIdentityPayload,
  getOrCreateDeviceIdentity,
  signDeviceIdentityBinding,
  verifyDeviceIdentityBinding,
} from '../deviceIdentity';

describe('Sesame per-device identity', () => {
  it('binds the account, DeviceID, X25519 key and Ed25519 key together', async () => {
    const userId = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    const identity = await getOrCreateDeviceIdentity(userId, deviceId);
    const devicePublicKey = btoa('x25519-device-public-key');
    const signature = await signDeviceIdentityBinding({
      userId,
      deviceId,
      devicePublicKey,
      identity,
    });

    await expect(verifyDeviceIdentityBinding({
      userId,
      deviceId,
      devicePublicKey,
      signingPublicKey: identity.publicB64,
      signature,
    })).resolves.toBe(true);
    await expect(verifyDeviceIdentityBinding({
      userId,
      deviceId: crypto.randomUUID(),
      devicePublicKey,
      signingPublicKey: identity.publicB64,
      signature,
    })).resolves.toBe(false);
  });

  it('uses an unambiguous versioned canonical payload', () => {
    expect(canonicalDeviceIdentityPayload({
      userId: 'u',
      deviceId: 'd',
      devicePublicKey: 'kx',
      signingPublicKey: 'sig',
    })).toBe(
      '{"protocol":"forsure-sesame-device","version":1,"userId":"u","deviceId":"d","devicePublicKey":"kx","signingPublicKey":"sig"}',
    );
  });
});
