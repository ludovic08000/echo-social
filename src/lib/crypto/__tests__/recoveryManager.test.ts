import { describe, it, expect } from 'vitest';
import { attemptRecovery } from '../recoveryManager';

describe('recoveryManager', () => {
  it('returns a tagged failure when PIN backup is unavailable', async () => {
    const res = await attemptRecovery('user-1', { source: 'pin', pin: '000000' });
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.source).toBe('pin');
      expect(typeof res.reason).toBe('string');
    }
  });

  it('never throws on unknown source', async () => {
    // @ts-expect-error — runtime guard test
    const res = await attemptRecovery('u', { source: 'nope' });
    expect(res.ok).toBe(false);
  });

  it('catches thrown errors and returns them tagged', async () => {
    const res = await attemptRecovery('user-1', { source: 'recovery_key', key: 'invalid' });
    expect(res.ok).toBe(false);
    if (res.ok === false) expect(res.source).toBe('recovery_key');
  });
});
