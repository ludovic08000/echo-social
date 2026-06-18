import { Blob as NodeBlob } from 'node:buffer';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { decryptMedia, encryptMedia, generateMediaKey } from '../mediaEncrypt';

describe('mediaEncrypt', () => {
  beforeAll(() => {
    vi.stubGlobal('Blob', NodeBlob);
  });

  it('round-trips encrypted media without changing the wire format', async () => {
    const plaintext = new TextEncoder().encode('forsure media payload');
    const file = new Blob([plaintext], { type: 'text/plain' });
    const { key } = await generateMediaKey();

    const encrypted = await encryptMedia(file, key);
    expect(encrypted.type).toBe('application/octet-stream');
    expect(encrypted.size).toBeGreaterThan(12 + plaintext.byteLength);

    const encryptedBytes = await encrypted.arrayBuffer();
    const decrypted = await decryptMedia(encryptedBytes, key);
    expect(Array.from(new Uint8Array(decrypted))).toEqual(Array.from(plaintext));
  });
});
