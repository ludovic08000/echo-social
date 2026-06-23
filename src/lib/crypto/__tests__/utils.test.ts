import { describe, it, expect } from 'vitest';
import { bufferToBase64, base64ToBuffer, constantTimeEqual, concatBuffers, encodeString, decodeString } from '../utils';

// Note: These tests bypass hardCrypto/hardGlobals since Node crypto is available natively in vitest

describe('bufferToBase64 / base64ToBuffer', () => {
  it('round-trips arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 127, 128, 255]);
    const b64 = bufferToBase64(original.buffer);
    const restored = new Uint8Array(base64ToBuffer(b64));
    expect(restored).toEqual(original);
  });

  it('handles empty buffer', () => {
    const b64 = bufferToBase64(new ArrayBuffer(0));
    expect(b64).toBe('');
    const restored = base64ToBuffer(b64);
    expect(restored.byteLength).toBe(0);
  });
});

describe('constantTimeEqual', () => {
  it('returns true for identical arrays', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    expect(constantTimeEqual(a, b)).toBe(true);
  });

  it('returns false for different arrays', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 4]);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it('returns false for different lengths', () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([1, 2, 3]);
    expect(constantTimeEqual(a, b)).toBe(false);
  });
});

describe('concatBuffers', () => {
  it('concatenates multiple buffers', () => {
    const a = new Uint8Array([1, 2]).buffer;
    const b = new Uint8Array([3, 4, 5]).buffer;
    const result = new Uint8Array(concatBuffers(a, b));
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });
});

describe('encodeString / decodeString', () => {
  it('round-trips unicode', () => {
    const str = 'Bonjour 🔒 chiffré!';
    const buf = encodeString(str);
    expect(decodeString(buf)).toBe(str);
  });

  it('keeps iOS and Windows message payloads byte-perfect', () => {
    const payloads = [
      'Salut iOS <-> Windows - accents: éèàù ç Ç œ',
      'emoji family: 👨‍👩‍👧‍👦 thumbs: 👍🏽 fire: 🔥',
      'composed=é decomposed=e\u0301',
      `Photo\x00MKEY:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`,
      'line1\r\nline2\nline3',
    ];

    for (const payload of payloads) {
      const encoded = encodeString(payload);
      const asBase64 = bufferToBase64(encoded);
      const decoded = decodeString(base64ToBuffer(asBase64));

      expect(decoded).toBe(payload);
      expect([...new Uint8Array(base64ToBuffer(asBase64))]).toEqual([...new Uint8Array(encoded)]);
    }
  });
});
