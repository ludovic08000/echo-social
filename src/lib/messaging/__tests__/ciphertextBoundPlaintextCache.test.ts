import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CiphertextBoundPlaintextCache,
  __test__,
} from '../ciphertextBoundPlaintextCache';

describe('CiphertextBoundPlaintextCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns plaintext only for the exact encrypted body', () => {
    const cache = new CiphertextBoundPlaintextCache(10);
    cache.set('message-1', 'bonjour', 'cipher-A');

    expect(cache.get('message-1', 'cipher-A')).toBe('bonjour');
    expect(cache.get('message-1', 'cipher-B')).toBeUndefined();
  });

  it('allows a freshly sent unbound optimistic value only inside the short TTL', () => {
    const cache = new CiphertextBoundPlaintextCache(10);
    cache.set('message-2', 'optimiste');

    expect(__test__.entryBody(cache, 'message-2')).toBeNull();
    expect(cache.get('message-2', 'server-cipher')).toBe('optimiste');

    vi.advanceTimersByTime(__test__.optimisticTtlMs + 1);
    expect(cache.get('message-2', 'server-cipher')).toBeUndefined();
  });

  it('evicts the least-recently-used entry', () => {
    const cache = new CiphertextBoundPlaintextCache(2);
    cache.set('a', 'A', 'ca');
    cache.set('b', 'B', 'cb');
    expect(cache.get('a', 'ca')).toBe('A');
    cache.set('c', 'C', 'cc');

    expect(cache.get('a', 'ca')).toBe('A');
    expect(cache.get('b', 'cb')).toBeUndefined();
    expect(cache.get('c', 'cc')).toBe('C');
  });
});
