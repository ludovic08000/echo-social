import { describe, expect, it } from 'vitest';
import {
  signedTreeHeadBytes,
  verifyTreeHeadChain,
  verifyTreeHeadSignature,
  type KeyTransparencySigningKey,
  type KeyTransparencyTreeHead,
} from '../keyTransparency';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function makeSigningKey(): Promise<{ key: KeyTransparencySigningKey; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' } as any, true, ['sign', 'verify']) as CryptoKeyPair;
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    key: {
      id: '00000000-0000-4000-8000-000000000001',
      publicKeyJwk,
      algorithm: 'Ed25519',
    },
    privateKey: pair.privateKey,
  };
}

async function signHead(
  privateKey: CryptoKey,
  head: Omit<KeyTransparencyTreeHead, 'signatureHex'>,
): Promise<KeyTransparencyTreeHead> {
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' } as any,
    privateKey,
    signedTreeHeadBytes(head),
  );
  return {
    ...head,
    signatureHex: bytesToHex(new Uint8Array(signature)),
  };
}

describe('key transparency verification', () => {
  it('verifies an Ed25519 signed tree head', async () => {
    const { key, privateKey } = await makeSigningKey();
    const head = await signHead(privateKey, {
      epoch: 1,
      leafCount: 2,
      rootHash: 'a'.repeat(64),
      prevEpoch: null,
      signingKeyId: key.id,
      createdAt: new Date().toISOString(),
    });

    await expect(verifyTreeHeadSignature(head, key)).resolves.toBe(true);
  });

  it('rejects a tampered signed tree head', async () => {
    const { key, privateKey } = await makeSigningKey();
    const head = await signHead(privateKey, {
      epoch: 1,
      leafCount: 2,
      rootHash: 'a'.repeat(64),
      prevEpoch: null,
      signingKeyId: key.id,
      createdAt: new Date().toISOString(),
    });

    await expect(verifyTreeHeadSignature({ ...head, rootHash: 'b'.repeat(64) }, key)).resolves.toBe(false);
  });

  it('marks a broken epoch chain even when signatures are valid', async () => {
    const { key, privateKey } = await makeSigningKey();
    const first = await signHead(privateKey, {
      epoch: 1,
      leafCount: 1,
      rootHash: '1'.repeat(64),
      prevEpoch: null,
      signingKeyId: key.id,
      createdAt: new Date().toISOString(),
    });
    const second = await signHead(privateKey, {
      epoch: 2,
      leafCount: 1,
      rootHash: '2'.repeat(64),
      prevEpoch: null,
      signingKeyId: key.id,
      createdAt: new Date().toISOString(),
    });

    const verified = await verifyTreeHeadChain([second, first], [key]);
    expect(verified.find(head => head.epoch === 1)?.signatureOk).toBe(true);
    expect(verified.find(head => head.epoch === 2)?.signatureOk).toBe(true);
    expect(verified.find(head => head.epoch === 2)?.chainOk).toBe(false);
  });
});
