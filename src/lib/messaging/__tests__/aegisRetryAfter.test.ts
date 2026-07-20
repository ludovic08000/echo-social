import { describe, expect, it } from 'vitest';
import { parseRetryAfter, parseRetryAfterWithDefault } from '../aegisRetryAfter';

describe('Aegis Retry-After parsing', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('12')).toBe(12_000);
    expect(parseRetryAfter(3)).toBe(3_000);
  });

  it('parses an HTTP-date relative to now', () => {
    const now = Date.parse('2026-07-16T08:00:00Z');
    expect(parseRetryAfter('Thu, 16 Jul 2026 08:00:10 GMT', now)).toBe(10_000);
  });

  it('rejects malformed values', () => {
    expect(parseRetryAfter('1.5')).toBeUndefined();
    expect(parseRetryAfter('-1')).toBeUndefined();
    expect(parseRetryAfter('tomorrow maybe')).toBeUndefined();
  });

  it('uses a safe one-second minimum with a default', () => {
    expect(parseRetryAfterWithDefault('0', 20_000)).toBe(1_000);
    expect(parseRetryAfterWithDefault(undefined, 20_000)).toBe(20_000);
  });
});
