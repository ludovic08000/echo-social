/**
 * E2EE core tests — encrypt/decrypt, envelope validation, plaintext rejection
 * 
 * These tests use the raw crypto functions directly (no IndexedDB / Supabase).
 */
import { describe, it, expect, vi } from 'vitest';
import { encryptMessage, decryptMessage, isEncryptedMessage } from '../e2ee';
import { hardCrypto } from '../cryptoIntegrity';
import { KX_KEY_PARAMS, SIG_KEY_PARAMS, AES_ALGO, AES_KEY_LENGTH, HKDF_HASH, PROTOCOL_VERSION } from '../constants';
import { bufferToBase64, encodeString } from '../utils';

// ─── Helpers ───

async function generateAESKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: AES_ALGO, length: AES_KEY_LENGTH },
    true,
    ['encrypt', 'decrypt'],
  );
}

async function generateEd25519Pair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { name: 'Ed25519' } as any,
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
}

// ─── Tests ───

describe('isEncryptedMessage', () => {
  it('detects valid encrypted envelope', () => {
    const envelope = JSON.stringify({ v: 2, kem: 'X25519', ct: 'abc', iv: 'def', sig: 'ghi', fp: 'x', ts: 1, seq: 0 });
    expect(isEncryptedMessage(envelope)).toBe(true);
  });

  it('rejects plaintext', () => {
    expect(isEncryptedMessage('Hello world')).toBe(false);
    expect(isEncryptedMessage('Bonjour')).toBe(false);
    expect(isEncryptedMessage('')).toBe(false);
  });

  it('rejects partial JSON without required fields', () => {
    expect(isEncryptedMessage(JSON.stringify({ v: 2 }))).toBe(false);
    expect(isEncryptedMessage(JSON.stringify({ kem: 'X25519' }))).toBe(false);
    expect(isEncryptedMessage(JSON.stringify({ hello: 'world' }))).toBe(false);
  });

  it('rejects malformed JSON', () => {
    expect(isEncryptedMessage('{broken')).toBe(false);
  });
});

describe('encrypt → decrypt round-trip', () => {
  it('encrypts and decrypts a message correctly', async () => {
    const aesKey = await generateAESKey();
    const sigPair = await generateEd25519Pair();
    const fp = 'test-fingerprint-abc123';

    const ciphertext = await encryptMessage('Bonjour le monde!', aesKey, sigPair.privateKey, fp, 0);

    // Ciphertext should be valid encrypted envelope
    expect(isEncryptedMessage(ciphertext)).toBe(true);

    // Ciphertext should NOT contain plaintext
    expect(ciphertext).not.toContain('Bonjour le monde!');

    // Decrypt
    const sigPubRaw = await crypto.subtle.exportKey('raw', sigPair.publicKey);
    const sigPubB64 = bufferToBase64(sigPubRaw);
    const result = await decryptMessage(ciphertext, aesKey, sigPubB64);

    expect(result.plaintext).toBe('Bonjour le monde!');
    expect(result.verified).toBe(true);
    expect(result.fingerprint).toBe(fp);
  });

  it('fails decryption with wrong key', async () => {
    const key1 = await generateAESKey();
    const key2 = await generateAESKey();
    const sigPair = await generateEd25519Pair();

    const ciphertext = await encryptMessage('secret', key1, sigPair.privateKey, 'fp', 0);

    await expect(decryptMessage(ciphertext, key2)).rejects.toThrow();
  });

  it('marks signature as unverified with wrong signing key', async () => {
    const aesKey = await generateAESKey();
    const sigPair1 = await generateEd25519Pair();
    const sigPair2 = await generateEd25519Pair();

    const ciphertext = await encryptMessage('test', aesKey, sigPair1.privateKey, 'fp', 0);

    // Decrypt with wrong public signing key
    const wrongPubRaw = await crypto.subtle.exportKey('raw', sigPair2.publicKey);
    const result = await decryptMessage(ciphertext, aesKey, bufferToBase64(wrongPubRaw));

    expect(result.plaintext).toBe('test');
    expect(result.verified).toBe(false);
  });
});

describe('timestamp handling', () => {
  it('keeps old signed history decryptable after restore', async () => {
    const aesKey = await generateAESKey();
    const sigPair = await generateEd25519Pair();
    const oldNow = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(oldNow);

    try {
      const ciphertext = await encryptMessage('old msg', aesKey, sigPair.privateKey, 'fp', 0);
      const sigPubRaw = await crypto.subtle.exportKey('raw', sigPair.publicKey);
      const result = await decryptMessage(ciphertext, aesKey, bufferToBase64(sigPubRaw));

      expect(result.plaintext).toBe('old msg');
      expect(result.verified).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('marks tampered timestamps as unverified when signer is known', async () => {
    const aesKey = await generateAESKey();
    const sigPair = await generateEd25519Pair();

    const ciphertext = await encryptMessage('old msg', aesKey, sigPair.privateKey, 'fp', 0);
    const envelope = JSON.parse(ciphertext);
    envelope.ts = Date.now() - 8 * 24 * 60 * 60 * 1000;

    const sigPubRaw = await crypto.subtle.exportKey('raw', sigPair.publicKey);
    const result = await decryptMessage(JSON.stringify(envelope), aesKey, bufferToBase64(sigPubRaw));

    expect(result.plaintext).toBe('old msg');
    expect(result.verified).toBe(false);
  });
});

describe('plaintext body rejection in encrypted context', () => {
  it('plaintext string is NOT a valid encrypted message', () => {
    const bodies = [
      'Hey how are you?',
      'Salut ça va ?',
      '12345',
      '<script>alert(1)</script>',
      '{"name": "John"}',  // JSON but not encrypted envelope
    ];
    for (const body of bodies) {
      expect(isEncryptedMessage(body)).toBe(false);
    }
  });
});
