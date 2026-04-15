import { describe, it, expect } from 'vitest';

const applyRetryPolicy = (message: { retryCount: number; updatedAt: number; encryptedBody: string | null }, mode: 'retry' | 'secure_wait') => {
  const next = { ...message };
  if (mode === 'retry') {
    next.retryCount++;
  }
  next.updatedAt = Date.now();
  if (mode === 'secure_wait') {
    next.encryptedBody = null;
  }
  return next;
};

describe('messageQueue retry policy', () => {
  it('preserves first encrypted payload on normal retry', () => {
    const original = {
      retryCount: 0,
      updatedAt: 1,
      encryptedBody: JSON.stringify({
        encryptionMode: 'ratchet',
        x3dh: { ik: 'ik', ek: 'ek', spkId: 7 },
        hdr: { dh: 'dh', pn: 0, n: 0 },
        ct: 'cipher',
      }),
    };

    const retried = applyRetryPolicy(original, 'retry');
    expect(retried.retryCount).toBe(1);
    expect(retried.encryptedBody).toBe(original.encryptedBody);
  });

  it('forces re-encryption only while waiting for secure channel', () => {
    const original = {
      retryCount: 0,
      updatedAt: 1,
      encryptedBody: JSON.stringify({ encryptionMode: 'ratchet', ct: 'cipher' }),
    };

    const retried = applyRetryPolicy(original, 'secure_wait');
    expect(retried.retryCount).toBe(0);
    expect(retried.encryptedBody).toBeNull();
  });
});
