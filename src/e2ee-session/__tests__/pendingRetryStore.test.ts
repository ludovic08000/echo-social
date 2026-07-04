import { describe, it, expect, beforeEach } from 'vitest';
import {
  decideRetry,
  noteRetryAttempt,
  clearRetry,
  _resetRetryStore,
  MAX_DECRYPT_RETRIES,
  RETRY_COOLDOWN_MS,
} from '../pendingRetryStore';

describe('decideRetry (pure)', () => {
  it('allows retry on the first failure', () => {
    const d = decideRetry(undefined, 1000);
    expect(d.shouldRetry).toBe(true);
    expect(d.exhausted).toBe(false);
    expect(d.attempts).toBe(1);
  });

  it('exhausts exactly at MAX_DECRYPT_RETRIES', () => {
    const d = decideRetry({ attempts: MAX_DECRYPT_RETRIES - 1, lastAttemptAt: 0 }, 1000);
    expect(d.attempts).toBe(MAX_DECRYPT_RETRIES);
    expect(d.exhausted).toBe(true);
    expect(d.shouldRetry).toBe(false);
  });
});

describe('noteRetryAttempt', () => {
  beforeEach(() => _resetRetryStore());

  it('retries a transient failure, then gives up after the budget', () => {
    const key = 'msg-transient';
    let now = 0;
    let last;
    // Space attempts beyond the cooldown so each one counts.
    for (let i = 0; i < MAX_DECRYPT_RETRIES; i++) {
      last = noteRetryAttempt(key, now);
      now += RETRY_COOLDOWN_MS + 1;
    }
    expect(last!.exhausted).toBe(true);
    expect(last!.shouldRetry).toBe(false);
  });

  it('does not burn the budget on a burst within the cooldown', () => {
    const key = 'msg-burst';
    const base = 10_000;
    const first = noteRetryAttempt(key, base);
    expect(first.attempts).toBe(1);

    // Several rapid re-routes inside the cooldown window.
    for (let i = 0; i < 20; i++) {
      const d = noteRetryAttempt(key, base + 10 * i);
      expect(d.attempts).toBe(1);      // count unchanged
      expect(d.exhausted).toBe(false); // still retryable
    }
  });

  it('clearRetry resets the count for a key', () => {
    const key = 'msg-clear';
    noteRetryAttempt(key, 0);
    noteRetryAttempt(key, RETRY_COOLDOWN_MS + 1);
    clearRetry(key);
    const afterClear = noteRetryAttempt(key, 100_000);
    expect(afterClear.attempts).toBe(1);
  });

  it('tracks keys independently', () => {
    const a = noteRetryAttempt('key-a', 0);
    const b = noteRetryAttempt('key-b', 0);
    expect(a.attempts).toBe(1);
    expect(b.attempts).toBe(1);
  });
});
