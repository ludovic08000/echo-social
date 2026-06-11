import { describe, it, expect, beforeEach } from 'vitest';
import { get, set, clear, clearAll, has } from '../memoryIdentityCache';

const USER = 'mem-user-1';

describe('memoryIdentityCache', () => {
  beforeEach(() => clearAll('test-reset'));

  it('starts empty', () => {
    expect(has(USER)).toBe(false);
    expect(get(USER)).toBeUndefined();
  });

  it('stores and retrieves identity bits without persisting', () => {
    set(USER, { deviceId: 'dev-1' });
    const snap = get(USER);
    expect(snap?.deviceId).toBe('dev-1');
    expect(snap?.version).toBe(1);
  });

  it('bumps version on each set', () => {
    set(USER, { deviceId: 'a' });
    set(USER, { deviceId: 'b' });
    expect(get(USER)?.version).toBe(2);
    expect(get(USER)?.deviceId).toBe('b');
  });

  it('clears per-user', () => {
    set(USER, { deviceId: 'a' });
    set('other', { deviceId: 'b' });
    clear(USER, 'logout');
    expect(has(USER)).toBe(false);
    expect(has('other')).toBe(true);
  });

  it('clearAll wipes everything', () => {
    set(USER, { deviceId: 'a' });
    set('other', { deviceId: 'b' });
    clearAll('lock');
    expect(has(USER)).toBe(false);
    expect(has('other')).toBe(false);
  });

  it('reacts to security epoch event by clearing all', async () => {
    set(USER, { deviceId: 'a' });
    // Touch the cache to install listeners (lazy install).
    get(USER);
    window.dispatchEvent(new CustomEvent('forsure-e2ee-security-epoch-changed'));
    expect(has(USER)).toBe(false);
  });
});
