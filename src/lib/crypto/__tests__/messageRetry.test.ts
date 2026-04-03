/**
 * Message queue / retry tests
 * 
 * Verifies that:
 * - Encrypted messages have unique IVs (no nonce reuse)
 * - Re-encrypting the same plaintext produces different ciphertexts
 * - Sequence numbers are enforced
 */
import { describe, it, expect } from 'vitest';
import { encryptMessage, isEncryptedMessage } from '../e2ee';

async function makeAESKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function makeSigPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'Ed25519' } as any, true, ['sign', 'verify']) as Promise<CryptoKeyPair>;
}

describe('Message queue / retry safety', () => {
  it('re-encrypting same plaintext produces different ciphertexts (unique IV)', async () => {
    const key = await makeAESKey();
    const sig = await makeSigPair();
    const text = 'Hello retry!';

    const ct1 = await encryptMessage(text, key, sig.privateKey, 'fp', 0);
    const ct2 = await encryptMessage(text, key, sig.privateKey, 'fp', 1);

    // Different ciphertext (different IV + seq)
    expect(ct1).not.toBe(ct2);

    // Both are valid envelopes
    expect(isEncryptedMessage(ct1)).toBe(true);
    expect(isEncryptedMessage(ct2)).toBe(true);

    // Different IVs
    const e1 = JSON.parse(ct1);
    const e2 = JSON.parse(ct2);
    expect(e1.iv).not.toBe(e2.iv);
  });

  it('sequence numbers are included in envelope', async () => {
    const key = await makeAESKey();
    const sig = await makeSigPair();

    const ct0 = JSON.parse(await encryptMessage('msg0', key, sig.privateKey, 'fp', 0));
    const ct1 = JSON.parse(await encryptMessage('msg1', key, sig.privateKey, 'fp', 1));
    const ct42 = JSON.parse(await encryptMessage('msg42', key, sig.privateKey, 'fp', 42));

    expect(ct0.seq).toBe(0);
    expect(ct1.seq).toBe(1);
    expect(ct42.seq).toBe(42);
  });

  it('envelope never contains plaintext in any field', async () => {
    const key = await makeAESKey();
    const sig = await makeSigPair();
    const secrets = ['mot_de_passe_secret', 'numéro_carte_1234', 'clé_privée_xyz'];

    for (const secret of secrets) {
      const ct = await encryptMessage(secret, key, sig.privateKey, 'fp', 0);
      expect(ct).not.toContain(secret);
      const env = JSON.parse(ct);
      expect(JSON.stringify(env)).not.toContain(secret);
    }
  });
});
