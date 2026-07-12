import { describe, expect, it, vi } from 'vitest';
import { fanoutNeedsRepair, repairFanoutWithRetry } from '@/lib/messaging/fanoutRepair';

const input = {
  messageId: 'message-1',
  conversationId: 'conversation-1',
  senderUserId: 'sender-1',
  plaintext: 'secret',
};

describe('fanout repair', () => {
  it('requires repair when targets exist but no copy was produced', () => {
    expect(fanoutNeedsRepair({ rows: [], hasTargets: true })).toBe(true);
    expect(fanoutNeedsRepair({ rows: [{}], hasTargets: true })).toBe(false);
    expect(fanoutNeedsRepair({ rows: [], hasTargets: false })).toBe(false);
    expect(fanoutNeedsRepair(null)).toBe(true);
  });

  it('retries zero-copy results until one encrypted copy is inserted', async () => {
    const attempt = vi
      .fn()
      .mockResolvedValueOnce({ inserted: 0, multiDevice: true })
      .mockResolvedValueOnce({ inserted: 0, multiDevice: true })
      .mockResolvedValueOnce({ inserted: 1, multiDevice: true });

    await expect(repairFanoutWithRetry(input, attempt, [0, 0, 0])).resolves.toEqual({
      inserted: 1,
      multiDevice: true,
    });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('does not retry when there are no device targets', async () => {
    const attempt = vi.fn().mockResolvedValue({ inserted: 0, multiDevice: false });

    await expect(repairFanoutWithRetry(input, attempt, [0, 0, 0])).resolves.toEqual({
      inserted: 0,
      multiDevice: false,
    });
    expect(attempt).toHaveBeenCalledOnce();
  });

  it('rejects after the bounded retry budget still produces zero copies', async () => {
    const attempt = vi.fn().mockResolvedValue({ inserted: 0, multiDevice: true });

    await expect(repairFanoutWithRetry(input, attempt, [0, 0, 0])).rejects.toThrow(
      'E_FANOUT_ZERO_COPIES_AFTER_RETRY',
    );
    expect(attempt).toHaveBeenCalledTimes(3);
  });
});
