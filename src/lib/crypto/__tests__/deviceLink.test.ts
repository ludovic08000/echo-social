/**
 * Device link / new device transfer tests.
 */
import { describe, it, expect } from 'vitest';
import { bufferToBase64, base64ToBuffer } from '../utils';
import {
  buildDeviceLinkQrData,
  decryptDeviceLinkPayload,
  deviceLinkPublicKeysEqual,
  encryptDeviceLinkPayload,
  generateDeviceLinkKeyPair,
  generateDeviceLinkToken,
  parseDeviceLinkQrPayload,
  parseDeviceLinkToken,
} from '../deviceLinkEnvelope';

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

describe('Device link crypto (new device)', () => {
  it('encrypts the approved transfer for the requesting device public key', async () => {
    const requester = await generateDeviceLinkKeyPair();
    const keysJson = JSON.stringify({
      'e2ee:identity-keys': [{ id: 'user1', key: 'secret' }],
      'plaintext:cache': [{ id: 'msg1', plaintext: 'cached history' }],
    });
    const token = generateDeviceLinkToken();
    const qrData = buildDeviceLinkQrData(token, requester.publicJwk);
    const context = { tokenHash: 'hash-token-1', requesterDeviceId: 'requester-device-1' };

    const envelope = await encryptDeviceLinkPayload(keysJson, requester.publicJwk, context);
    const wire = JSON.stringify(envelope);

    expect(parseDeviceLinkToken(qrData)).toBe(token);
    expect(qrData).not.toContain('secret');
    expect(qrData).not.toContain('cached history');
    expect(deviceLinkPublicKeysEqual(parseDeviceLinkQrPayload(qrData).pk!, requester.publicJwk)).toBe(true);
    expect(wire).not.toContain('secret');
    expect(wire).not.toContain('cached history');

    const restored = JSON.parse(await decryptDeviceLinkPayload(envelope, requester.privateJwk, context));
    expect(restored['e2ee:identity-keys'][0].key).toBe('secret');
    expect(restored['plaintext:cache'][0].plaintext).toBe('cached history');
  });

  it('rejects an approved transfer on the wrong requesting private key', async () => {
    const requester = await generateDeviceLinkKeyPair();
    const otherDevice = await generateDeviceLinkKeyPair();
    const envelope = await encryptDeviceLinkPayload('secret data', requester.publicJwk);

    await expect(decryptDeviceLinkPayload(envelope, otherDevice.privateJwk)).rejects.toThrow();
  });

  it('binds approved transfers to the token hash and requester device id', async () => {
    const requester = await generateDeviceLinkKeyPair();
    const context = { tokenHash: 'hash-token-a', requesterDeviceId: 'device-a' };
    const envelope = await encryptDeviceLinkPayload('bound secret', requester.publicJwk, context);

    await expect(decryptDeviceLinkPayload(envelope, requester.privateJwk, {
      tokenHash: 'hash-token-b',
      requesterDeviceId: 'device-a',
    })).rejects.toThrow();
    await expect(decryptDeviceLinkPayload(envelope, requester.privateJwk, {
      tokenHash: 'hash-token-a',
      requesterDeviceId: 'device-b',
    })).rejects.toThrow();
    await expect(decryptDeviceLinkPayload(envelope, requester.privateJwk, context)).resolves.toBe('bound secret');
  });

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

  it('QR code contains token and requester public key, but no PIN or private material', async () => {
    const pin = 'XYZW5678';
    const token = generateDeviceLinkToken();
    const requester = await generateDeviceLinkKeyPair();
    const qrData = buildDeviceLinkQrData(token, requester.publicJwk);
    const parsed = parseDeviceLinkQrPayload(qrData);

    expect(qrData).toContain(token);
    expect(qrData).not.toContain(pin);
    expect(qrData).not.toContain(requester.privateJwk.d);
    expect(deviceLinkPublicKeysEqual(parsed.pk!, requester.publicJwk)).toBe(true);
  });

  it('detects requester public key substitution during approval', async () => {
    const requester = await generateDeviceLinkKeyPair();
    const substituted = await generateDeviceLinkKeyPair();
    const token = generateDeviceLinkToken();
    const qrData = buildDeviceLinkQrData(token, requester.publicJwk);

    expect(deviceLinkPublicKeysEqual(parseDeviceLinkQrPayload(qrData).pk!, requester.publicJwk)).toBe(true);
    expect(deviceLinkPublicKeysEqual(parseDeviceLinkQrPayload(qrData).pk!, substituted.publicJwk)).toBe(false);
  });
});
