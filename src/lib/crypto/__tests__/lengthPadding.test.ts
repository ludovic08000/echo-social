import { describe, it, expect } from 'vitest';
import { padPlaintext, unpadPlaintext, paddedLength } from '../lengthPadding';

describe('Length padding (Lot B)', () => {
  it('rounds up short messages to the minimum bucket', () => {
    expect(paddedLength(0)).toBe(64);
    expect(paddedLength(10)).toBe(64);
    expect(paddedLength(63)).toBe(64);
  });

  it('grows monotonically and quantizes by power of two', () => {
    let prev = 0;
    for (let n = 0; n < 4096; n += 17) {
      const p = paddedLength(n);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeGreaterThan(n);
      prev = p;
    }
  });

  it('round-trips ASCII and unicode', () => {
    for (const msg of ['hi', 'a'.repeat(1), 'a'.repeat(65), '🙂🙃', '']) {
      expect(unpadPlaintext(padPlaintext(msg))).toBe(msg);
    }
  });

  it('hides exact length: small messages share a bucket', () => {
    expect(padPlaintext('a').length).toBe(padPlaintext('hello world').length);
  });

  it('rejects garbage padding', () => {
    expect(() => unpadPlaintext(new Uint8Array(64))).toThrow();
  });
});
