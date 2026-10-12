// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertPublishedSigningKeyMatches, validateTransparencySigningKey } from '../../supabase/functions/_shared/kt-signing-key';

async function pair() {
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey('jwk', kp.privateKey), pub: await crypto.subtle.exportKey('jwk', kp.publicKey) };
}
describe('stable transparency signing authority', () => {
  it('accepts and verifies a matching Ed25519 pair', async () => {
    const input = await pair();
    const key = await validateTransparencySigningKey(JSON.stringify(input));
    expect(key.pubJwk.x).toBe(input.pub.x);
    expect(key.pubJwk).not.toHaveProperty('d');
    expect(() => assertPublishedSigningKeyMatches(input.pub, key.pubJwk)).not.toThrow();
  });
  it.each([undefined, '', '   '])('refuses an absent configuration without generating an ephemeral identity', async (input) => {
    await expect(validateTransparencySigningKey(input)).rejects.toThrow('KT_SIGNING_KEY_NOT_CONFIGURED');
  });
  it.each(['{private-secret-is-here', '{}', '{"pub":{}}'])('uses a bounded error for invalid config', async (input) => {
    await expect(validateTransparencySigningKey(input)).rejects.toThrow(/^KT_SIGNING_KEY_INVALID$/);
  });
  it('rejects two unrelated public and private keys even with a forged matching x field', async () => {
    const a = await pair();
    const b = await pair();
    await expect(validateTransparencySigningKey(JSON.stringify({ priv: a.priv, pub: b.pub }))).rejects.toThrow('KT_SIGNING_KEY_INVALID');
    await expect(validateTransparencySigningKey(JSON.stringify({ priv: { ...a.priv, x: b.pub.x }, pub: b.pub }))).rejects.toThrow('KT_SIGNING_KEY_INVALID');
  });
  it('rejects private material in the supposedly public database record', async () => {
    const input = await pair();
    await expect(validateTransparencySigningKey(JSON.stringify({ priv: input.priv, pub: input.priv }))).rejects.toThrow('KT_SIGNING_KEY_INVALID');
    expect(() => assertPublishedSigningKeyMatches(input.priv, input.pub)).toThrow('KT_SIGNING_KEY_MISMATCH');
  });
  it('does not silently associate a new key with an existing signing authority', async () => {
    const a = await pair();
    const b = await pair();
    expect(() => assertPublishedSigningKeyMatches(a.pub, b.pub)).toThrow('KT_SIGNING_KEY_MISMATCH');
    const publisher = readFileSync('supabase/functions/kt-publish-epoch/index.ts', 'utf8');
    expect(publisher).not.toContain('crypto.subtle.generateKey');
    expect(publisher).toContain('assertPublishedSigningKeyMatches(row.public_key_jwk, pubJwk)');
  });
});
