import { describe, expect, it } from 'vitest';
import { detectMediaMimeType } from './mediaEncrypt';

function asciiBytes(value: string, prefix: number[] = []): Uint8Array {
  return new Uint8Array([...prefix, ...Array.from(value, (char) => char.charCodeAt(0))]);
}

describe('detectMediaMimeType', () => {
  it('detects common image signatures', () => {
    expect(detectMediaMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectMediaMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(detectMediaMimeType(asciiBytes('GIF89a'))).toBe('image/gif');
    expect(detectMediaMimeType(asciiBytes('WEBP', [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]))).toBe('image/webp');
  });

  it('distinguishes HEIC and MP4 ISO base media files', () => {
    expect(detectMediaMimeType(asciiBytes('ftypheic', [0, 0, 0, 0]))).toBe('image/heic');
    expect(detectMediaMimeType(asciiBytes('ftypisom', [0, 0, 0, 0]))).toBe('video/mp4');
  });

  it('returns null for unknown bytes', () => {
    expect(detectMediaMimeType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});
