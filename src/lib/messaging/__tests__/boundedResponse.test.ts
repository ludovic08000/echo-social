import { describe, expect, it } from 'vitest';
import { readResponseArrayBufferBounded } from '../boundedResponse';

describe('bounded attachment response reader', () => {
  it('streams an exact known-length body into one bounded result', async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { 'content-length': '4' },
    });
    const result = await readResponseArrayBufferBounded(response, 8, 4);
    expect(Array.from(new Uint8Array(result))).toEqual([1, 2, 3, 4]);
  });

  it('rejects an oversized announced body before reading it', async () => {
    const response = new Response(new Uint8Array([1]), {
      headers: { 'content-length': '1000' },
    });
    await expect(readResponseArrayBufferBounded(response, 10))
      .rejects.toThrow('ATTACHMENT_TOO_LARGE');
  });

  it('rejects an exact-size mismatch', async () => {
    const response = new Response(new Uint8Array([1, 2, 3]));
    await expect(readResponseArrayBufferBounded(response, 10, 4))
      .rejects.toThrow('ATTACHMENT_SIZE_MISMATCH');
  });
});
