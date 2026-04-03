/**
 * Backup / Restore tests — verify encrypt-then-decrypt cycle for key material
 * 
 * These test the pure crypto functions (encryptBlob/decryptBlob equivalent)
 * without Supabase or IndexedDB dependencies.
 */
import { describe, it, expect } from 'vitest';
import { bufferToBase64, base64ToBuffer } from '../utils';

// Pure crypto backup functions (extracted from useSecureBackup for testing)
const PBKDF2_ITERATIONS = 600_000;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptBlob(data: string, password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(data));
  return {
    encrypted: bufferToBase64(ct),
    salt: bufferToBase64(salt.buffer),
    iv: bufferToBase64(iv.buffer),
  };
}

async function decryptBlob(encrypted: string, salt: string, iv: string, password: string): Promise<string> {
  const saltBuf = new Uint8Array(base64ToBuffer(salt));
  const ivBuf = new Uint8Array(base64ToBuffer(iv));
  const key = await deriveKey(password, saltBuf);
  const ct = base64ToBuffer(encrypted);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, ct);
  return new TextDecoder().decode(pt);
}

describe('Backup / Restore crypto', () => {
  it('round-trips key material through encrypt → decrypt', async () => {
    const keyData = JSON.stringify({
      'e2ee:identity-keys': [{ id: 'user1', publicKeyJWK: { kty: 'OKP' }, fingerprint: 'ABCD' }],
      'ratchet:states': [{ convId: 'c1', data: 'serialized-state' }],
      'fingerprints': '{"peer1":"EFGH"}',
    });

    const password = 'MyStr0ngP@ssw0rd!';
    const { encrypted, salt, iv } = await encryptBlob(keyData, password);

    // Encrypted blob should not contain plaintext
    expect(encrypted).not.toContain('identity-keys');
    expect(encrypted).not.toContain('fingerprint');
    expect(encrypted).not.toContain('ABCD');

    // Decrypt with correct password
    const restored = await decryptBlob(encrypted, salt, iv, password);
    expect(JSON.parse(restored)).toEqual(JSON.parse(keyData));
  });

  it('fails with wrong password', async () => {
    const { encrypted, salt, iv } = await encryptBlob('secret keys', 'correct-password');
    await expect(decryptBlob(encrypted, salt, iv, 'wrong-password')).rejects.toThrow();
  });

  it('different passwords produce different ciphertexts', async () => {
    const data = 'same key material';
    const r1 = await encryptBlob(data, 'password1');
    const r2 = await encryptBlob(data, 'password2');
    expect(r1.encrypted).not.toBe(r2.encrypted);
  });

  it('backup is non-deterministic (random salt/iv)', async () => {
    const data = 'keys';
    const password = 'same-password';
    const r1 = await encryptBlob(data, password);
    const r2 = await encryptBlob(data, password);
    // Same password + same data → different ciphertext (random salt/iv)
    expect(r1.encrypted).not.toBe(r2.encrypted);
    expect(r1.salt).not.toBe(r2.salt);
    // Both decrypt correctly
    expect(await decryptBlob(r1.encrypted, r1.salt, r1.iv, password)).toBe(data);
    expect(await decryptBlob(r2.encrypted, r2.salt, r2.iv, password)).toBe(data);
  });
});
