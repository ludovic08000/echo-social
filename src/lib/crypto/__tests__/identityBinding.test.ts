import { describe, expect, it } from 'vitest';
import {
  exportPublicKeyBundle,
  generateIdentityKeys,
  verifyPublicIdentityBinding,
} from '../keyManager';

describe('Aegis composite account identity', () => {
  it('binds X25519 and Ed25519 into one signed fingerprint', async () => {
    const bundle = await exportPublicKeyBundle(await generateIdentityKeys());

    await expect(verifyPublicIdentityBinding(bundle)).resolves.toBe(true);
    await expect(verifyPublicIdentityBinding({
      ...bundle,
      identityKey: `${bundle.identityKey.slice(0, -2)}AA`,
    })).resolves.toBe(false);
    await expect(verifyPublicIdentityBinding({
      ...bundle,
      signingKey: `${bundle.signingKey.slice(0, -2)}AA`,
    })).resolves.toBe(false);
    await expect(verifyPublicIdentityBinding({
      ...bundle,
      fingerprint: `${bundle.fingerprint[0] === 'F' ? 'E' : 'F'}${bundle.fingerprint.slice(1)}`,
    })).resolves.toBe(false);
    await expect(verifyPublicIdentityBinding({
      ...bundle,
      bindingSignature: `${bundle.bindingSignature.slice(0, -2)}AA`,
    })).resolves.toBe(false);
  });
});
