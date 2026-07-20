import { describe, expect, it } from 'vitest';
import {
  applyFullJitter,
  computeAegisRetryDelay,
  exponentialBackoffMaxAttempts,
  exponentialBackoffSleepTime,
} from '../aegisBackoff';

// Test cases adapted from Signal Desktop's exponentialBackoff_test.std.ts.
describe('Aegis exponential backoff', () => {
  it('returns Signal-compatible early delays', () => {
    expect(exponentialBackoffSleepTime(1)).toBe(0);
    expect(exponentialBackoffSleepTime(2)).toBe(190);
    expect(exponentialBackoffSleepTime(3)).toBe(361);
    expect(exponentialBackoffSleepTime(4)).toBeCloseTo(685.9, 1);
    expect(exponentialBackoffSleepTime(5)).toBeCloseTo(1303.21, 1);
  });

  it('plateaus at fifteen minutes', () => {
    for (let attempt = 16; attempt < 100; attempt += 1) {
      expect(exponentialBackoffSleepTime(attempt)).toBe(15 * 60_000);
    }
  });

  it('respects custom options', () => {
    const options = {
      maxBackoffTime: 10_000,
      multiplier: 2,
      firstBackoffs: [1_000],
    } as const;
    expect(exponentialBackoffSleepTime(1, options)).toBe(1_000);
    expect(exponentialBackoffSleepTime(2, options)).toBe(2_000);
    expect(exponentialBackoffSleepTime(3, options)).toBe(4_000);
    expect(exponentialBackoffSleepTime(4, options)).toBe(8_000);
    expect(exponentialBackoffSleepTime(5, options)).toBe(10_000);
  });

  it('computes the Signal-compatible attempt budget', () => {
    expect(exponentialBackoffMaxAttempts(1)).toBe(2);
    expect(exponentialBackoffMaxAttempts(5_000)).toBe(6);
    expect(exponentialBackoffMaxAttempts(24 * 60 * 60_000)).toBe(110);
  });

  it('adds deterministic full jitter without exceeding the base delay', () => {
    expect(applyFullJitter(1_000, () => 0)).toBe(0);
    expect(applyFullJitter(1_000, () => 0.5)).toBe(500);
    expect(applyFullJitter(1_000, () => 1)).toBe(1_000);
  });

  it('never shortens an authoritative Retry-After delay', () => {
    expect(computeAegisRetryDelay({ attempt: 9, retryAfterMs: 12_345, random: () => 0 })).toBe(12_345);
  });

  it('rejects invalid attempts', () => {
    expect(() => exponentialBackoffSleepTime(0)).toThrow(RangeError);
    expect(() => exponentialBackoffSleepTime(1.5)).toThrow(RangeError);
  });
});
