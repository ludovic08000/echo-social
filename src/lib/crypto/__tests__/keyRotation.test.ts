/**
 * Key rotation tests — verify session key changes and re-derivation
 */
import { describe, it, expect } from 'vitest';
import { encryptMessage, decryptMessage, isEncryptedMessage } from '../e2ee';
import { bufferToBase64 } from '../utils';

const AES = { name: 'AES-GCM', length: 256 };
const SIG = { name: 'Ed25519' } as any;

async function makeAESKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(AES, true, ['encrypt', 'decrypt']);
}

async function makeSigPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(SIG, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

describe('Key rotation', () => {
  it('messages encrypted with old key cannot be decrypted with new key', async () => {
    const oldKey = await makeAESKey();
    const newKey = await makeAESKey();
    const sig = await makeSigPair();

    const ct = await encryptMessage('before rotation', oldKey, sig.privateKey, 'fp', 0);

    // Old key works
    const r1 = await decryptMessage(ct, oldKey);
    expect(r1.plaintext).toBe('before rotation');

    // New key fails
    await expect(decryptMessage(ct, newKey)).rejects.toThrow();
  });

  it('messages after rotation use new key successfully', async () => {
    const oldKey = await makeAESKey();
    const newKey = await makeAESKey();
    const sig = await makeSigPair();

    // Encrypt with new key (simulates post-rotation)
    const ct = await encryptMessage('after rotation', newKey, sig.privateKey, 'fp', 0);

    // New key works
    const r = await decryptMessage(ct, newKey);
    expect(r.plaintext).toBe('after rotation');

    // Old key fails
    await expect(decryptMessage(ct, oldKey)).rejects.toThrow();
  });

  it('different conversations have different session keys', async () => {
    const key1 = await makeAESKey();
    const key2 = await makeAESKey();
    const sig = await makeSigPair();

    const ct1 = await encryptMessage('conv1', key1, sig.privateKey, 'fp', 0);
    const ct2 = await encryptMessage('conv2', key2, sig.privateKey, 'fp', 0);

    // Cross-decryption fails
    await expect(decryptMessage(ct1, key2)).rejects.toThrow();
    await expect(decryptMessage(ct2, key1)).rejects.toThrow();

    // Correct keys work
    expect((await decryptMessage(ct1, key1)).plaintext).toBe('conv1');
    expect((await decryptMessage(ct2, key2)).plaintext).toBe('conv2');
  });
});
