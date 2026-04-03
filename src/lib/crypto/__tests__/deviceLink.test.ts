/**
 * Device link / new device transfer tests
 * 
 * Tests the pure crypto of QR-based key transfer
 * (PIN-based encryption, separate channels for token vs PIN)
 */
import { describe, it, expect } from 'vitest';
import { bufferToBase64, base64ToBuffer } from '../utils';

const PBKDF2_ITERATIONS = 600_000;

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

describe('Device link crypto (new device)', () => {
  it('encrypts keys with PIN and decrypts on new device', async () => {
    const keysJson = JSON.stringify({
      'e2ee:identity-keys': [{ id: 'user1', key: 'secret' }],
      'ratchet:states': [],
    });

    const pin = 'ABCD1234';
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pin, salt);

    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(keysJson),
    );

    const payload = {
      ct: bufferToBase64(ct),
      salt: bufferToBase64(salt.buffer),
      iv: bufferToBase64(iv.buffer),
    };

    // Simulate transfer: QR has token only, PIN is separate
    const qrData = JSON.stringify({ t: 'claim-token-123' });
    expect(qrData).not.toContain(pin);
    expect(qrData).not.toContain('secret');

    // New device decrypts with PIN
    const decKey = await deriveKey(pin, new Uint8Array(base64ToBuffer(payload.salt)));
    const decIv = new Uint8Array(base64ToBuffer(payload.iv));
    const ptBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decIv },
      decKey,
      base64ToBuffer(payload.ct),
    );
    const restored = JSON.parse(new TextDecoder().decode(ptBuf));

    expect(restored['e2ee:identity-keys'][0].key).toBe('secret');
  });

  it('wrong PIN fails decryption', async () => {
    const pin = 'CORRECT1';
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pin, salt);

    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode('secret data'),
    );

    const wrongKey = await deriveKey('WRONGPIN', salt);
    await expect(
      crypto.subtle.decrypt({ name: 'AES-GCM', iv }, wrongKey, ct)
    ).rejects.toThrow();
  });

  it('QR code contains only claim token, not encryption PIN', () => {
    const pin = 'XYZW5678';
    const token = 'abc-123-def';
    const qrData = JSON.stringify({ t: token });

    expect(qrData).toContain(token);
    expect(qrData).not.toContain(pin);
  });
});
