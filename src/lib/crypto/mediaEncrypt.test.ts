import { describe, expect, it, vi } from 'vitest';
import {
  decryptMediaWithMetadata,
  detectMediaMimeType,
  encryptMedia,
  generateMediaKey,
  importMediaKey,
} from './mediaEncrypt';
import { bufferToBase64 } from './utils';
import { hardCrypto } from './cryptoIntegrity';
import { MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES } from '@/lib/messaging/attachmentLimits';

function asciiBytes(value: string, prefix: number[] = []): Uint8Array {
  return new Uint8Array([...prefix, ...Array.from(value, char => char.charCodeAt(0))]);
}

function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Blob read failed'));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(blob);
  });
}

describe('encrypted media format', () => {
  it('detects common image signatures', () => {
    expect(detectMediaMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectMediaMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(detectMediaMimeType(asciiBytes('GIF89a'))).toBe('image/gif');
    expect(detectMediaMimeType(asciiBytes('WEBP', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]))).toBe('image/webp');
  });

  it('uses compatible brands to distinguish AVIF, HEIC and MP4', () => {
    expect(detectMediaMimeType(asciiBytes('ftypmif1\0\0\0\0avif', [0, 0, 0, 0]))).toBe('image/avif');
    expect(detectMediaMimeType(asciiBytes('ftypheic', [0, 0, 0, 0]))).toBe('image/heic');
    expect(detectMediaMimeType(asciiBytes('ftypisom', [0, 0, 0, 0]))).toBe('video/mp4');
  });

  it('prefers the decrypted byte signature over a wrong declared MIME', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const source = {
      size: jpeg.byteLength,
      type: 'video/mp4',
      arrayBuffer: async () => jpeg.slice().buffer,
    } as unknown as Blob;
    const { key } = await generateMediaKey();
    const encrypted = await encryptMedia(source, key);
    const decrypted = await decryptMediaWithMetadata(await blobToArrayBuffer(encrypted), key);
    expect(decrypted.mimeType).toBe('image/jpeg');
    expect(new Uint8Array(decrypted.data)).toEqual(jpeg);
  });

  it('rejects an oversized file before reading it into memory', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const oversized = {
      size: MAX_OUTGOING_ATTACHMENT_CIPHERTEXT_BYTES,
      type: 'image/jpeg',
      arrayBuffer,
    } as unknown as Blob;
    const { key } = await generateMediaKey();
    await expect(encryptMedia(oversized, key)).rejects.toThrow('Média trop volumineux');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects media keys that are not exactly 256 bits', async () => {
    const invalid = bufferToBase64(new Uint8Array(31).buffer);
    await expect(importMediaKey(invalid)).rejects.toThrow('AES-256 invalide');
  });

  it('returns null for an unknown byte signature', () => {
    expect(detectMediaMimeType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('rejects encrypted bytes that do not contain the Aegis manifest', async () => {
    const { key } = await generateMediaKey();
    const iv = new Uint8Array(12);
    const ciphertext = await hardCrypto.encrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    );
    const wire = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    wire.set(iv);
    wire.set(new Uint8Array(ciphertext), iv.byteLength);
    await expect(decryptMediaWithMetadata(wire.buffer, key)).rejects.toThrow(
      'AEGIS_MEDIA_FORMAT_UNSUPPORTED',
    );
  });
});
