// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as wasm from '../wasm/generated/aegis_crypto';
import { libsignalIdentityFromVerifiedBundle, readLibsignalBundleMetadata, signLibsignalBundleBinding, verifyLibsignalBundleBinding } from '../libsignalBundleBinding';

const unpack = (bytes: Uint8Array): Uint8Array[] => {
  const fields = []; let offset = 0;
  while (offset < bytes.length) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
    offset += 4; fields.push(bytes.slice(offset, offset + length)); offset += length;
  }
  return fields;
};
const alice = '00000000-0000-4000-8000-000000000001';
const bob = '00000000-0000-4000-8000-000000000002';
let key: CryptoKeyPair; let publicKey: string; let bundle: Uint8Array; let stored: Uint8Array;
let signature: string;
const context = () => ({ userId: bob, deviceId: 'bob-ios', deviceNumber: 2, registrationId: 202,
  publicBundle: Buffer.from(bundle).toString('base64') });

describe('account-authorized device binds the actual Libsignal bundle', () => {
  beforeAll(async () => {
    await wasm.default({ module_or_path: readFileSync('src/lib/crypto/wasm/generated/aegis_crypto_bg.wasm') });
    key = await crypto.subtle.generateKey('Ed25519', true, ['sign','verify']) as CryptoKeyPair;
    publicKey = Buffer.from(await crypto.subtle.exportKey('raw', key.publicKey)).toString('base64');
    [stored,bundle] = unpack(await wasm.aegis_wasm_bundle_create(wasm.aegis_wasm_store_create(202), 2, 11, 12, 13));
    signature = await signLibsignalBundleBinding(context(), key.privateKey);
  });
  it('verifies before a real PQXDH exchange without replacing either identity', async () => {
    const bytes = await verifyLibsignalBundleBinding(context(), signature, publicKey);
    expect(bytes).toEqual(bundle);
    let a = await wasm.aegis_wasm_session_establish(wasm.aegis_wasm_store_create(101), alice, 1, bob, 2, bytes);
    a = await wasm.aegis_wasm_identity_bind(a, bob, 2, libsignalIdentityFromVerifiedBundle(bytes));
    let b = stored.slice();
    for (const plaintext of ['Bonjour 👋', 'Ancienne session toujours lisible']) {
      const [nextA, type, encrypted] = unpack(await wasm.aegis_wasm_message_encrypt(a, alice, 1, bob, 2, new TextEncoder().encode(plaintext)));
      a = nextA;
      const [nextB, clear] = unpack(await wasm.aegis_wasm_message_decrypt(b, bob, 2, alice, 1, type[0], encrypted));
      b = nextB;
      expect(new TextDecoder().decode(clear)).toBe(plaintext);
    }
    const [,nextBundle] = unpack(await wasm.aegis_wasm_bundle_create(b, 2, 21, 22, 23));
    expect(unpack(nextBundle)[1]).toEqual(unpack(bundle)[1]); // même identité, nouvelles préclés
  });
  it('pins a verified sender before first receive and rejects an impostor without losing the legitimate message', async () => {
    const [initial,aliceBundle] = unpack(await wasm.aegis_wasm_bundle_create(wasm.aegis_wasm_store_create(101),1,31,32,33));
    let a = initial;
    const senderContext = {userId:alice, deviceId:'alice-pc',deviceNumber:1,registrationId:101,publicBundle:Buffer.from(aliceBundle).toString('base64')};
    const proof = await signLibsignalBundleBinding(senderContext,key.privateKey);
    const verified = await verifyLibsignalBundleBinding(senderContext,proof,publicKey);
    const b = await wasm.aegis_wasm_identity_bind(stored,alice,1,libsignalIdentityFromVerifiedBundle(verified));
    const fake = await wasm.aegis_wasm_session_establish(wasm.aegis_wasm_store_create(999),alice,1,bob,2,bundle);
    const [,fakeType,forged] = unpack(await wasm.aegis_wasm_message_encrypt(fake,alice,1,bob,2,new TextEncoder().encode('fake')));
    await expect(wasm.aegis_wasm_message_decrypt(b,bob,2,alice,1,fakeType[0],forged)).rejects.toThrow();
    a = await wasm.aegis_wasm_session_establish(a,alice,1,bob,2,bundle);
    const [,kind,cipher] = unpack(await wasm.aegis_wasm_message_encrypt(a,alice,1,bob,2,new TextEncoder().encode('real')));
    const [,clear] = unpack(await wasm.aegis_wasm_message_decrypt(b,bob,2,alice,1,kind[0],cipher));
    expect(new TextDecoder().decode(clear)).toBe('real');
  });
  it.each([{ userId: alice }, { deviceId: 'other-device' }, { deviceNumber: 1 }, { registrationId: 404 }])(
    'rejects cross-account/device/registration substitution %o', async (changed) => {
      await expect(verifyLibsignalBundleBinding({ ...context(), ...changed }, signature, publicKey)).rejects.toThrow('BUNDLE_BINDING_INVALID');
    });
  it('rejects another device signing authority', async () => {
    const other = await crypto.subtle.generateKey('Ed25519', true, ['sign','verify']) as CryptoKeyPair;
    const otherPublic = Buffer.from(await crypto.subtle.exportKey('raw', other.publicKey)).toString('base64');
    await expect(verifyLibsignalBundleBinding(context(), signature, otherPublic)).rejects.toThrow('BUNDLE_BINDING_INVALID');
  });
  it('rejects an internally valid replacement Libsignal identity', async () => {
    const [,replacement] = unpack(await wasm.aegis_wasm_bundle_create(wasm.aegis_wasm_store_create(202), 2, 11, 12, 13));
    await expect(verifyLibsignalBundleBinding({ ...context(), publicBundle: Buffer.from(replacement).toString('base64') },
      signature, publicKey)).rejects.toThrow('BUNDLE_BINDING_INVALID');
  });
  it.each(['', 'unsigned', 'A'.repeat(88)])('never accepts missing/malformed/forged proof %s', async (proof) => {
    await expect(verifyLibsignalBundleBinding(context(), proof, publicKey)).rejects.toThrow('BUNDLE_BINDING_INVALID');
  });
  it('validates Rust metadata, rejects truncation, appended bytes and length overflow', () => {
    expect(readLibsignalBundleMetadata(bundle)).toEqual({ registrationId:202,deviceNumber:2,preKeyId:11,signedPreKeyId:12,kyberPreKeyId:13 });
    for (const malformed of [bundle.slice(0,23), bundle.slice(0,-1), new Uint8Array([...bundle,0]), Uint8Array.of(255,255,255,255)]) {
      expect(() => readLibsignalBundleMetadata(malformed)).toThrow('METADATA_INVALID');
    }
  });
});
