import { describe, expect, it, vi } from 'vitest';
import { runDeviceRpcWithTimeout } from '@/lib/api/deviceRpcTimeout';

describe('device finalization RPC timeout', () => {
  it('returns a completed RPC response', async () => {
    await expect(runDeviceRpcWithTimeout('DEVICE_RPC', async () => ({ ok: true }), 50))
      .resolves.toEqual({ ok: true });
  });

  it('aborts and reports a stable timeout instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | null = null;
      const request = runDeviceRpcWithTimeout(
        'DEVICE_RPC',
        (receivedSignal) => {
          signal = receivedSignal;
          return new Promise<never>(() => undefined);
        },
        20_000,
      );

      const rejection = expect(request).rejects.toThrow('DEVICE_RPC:TIMEOUT');
      await vi.advanceTimersByTimeAsync(20_000);
      await rejection;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
