import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cryptoGetState: vi.fn(),
  cryptoEnsureReady: vi.fn(),
  waitForAccountSynchronization: vi.fn(),
  getAccountSynchronizationPhase: vi.fn(),
  sendOutbound: vi.fn(),
  startRealtime: vi.fn(),
  startInbox: vi.fn(),
  syncInbox: vi.fn(),
}));

vi.mock('../cryptoApi', () => ({
  cryptoApi: {
    getState: mocks.cryptoGetState,
    ensureReady: mocks.cryptoEnsureReady,
  },
}));
vi.mock('@/lib/messaging/accountSyncBarrier', () => ({
  waitForAccountSynchronization: mocks.waitForAccountSynchronization,
  getAccountSynchronizationPhase: mocks.getAccountSynchronizationPhase,
}));
vi.mock('@/lib/messaging/aegisOutboundEngine', () => ({
  sendAegisOutboundMessage: mocks.sendOutbound,
}));
vi.mock('@/lib/messaging/realtimeKeySync', () => ({
  startRealtimeKeySync: mocks.startRealtime,
}));
vi.mock('@/lib/messaging/aegisDeviceInbox', () => ({
  startAegisDeviceInbox: mocks.startInbox,
  syncAegisDeviceInbox: mocks.syncInbox,
}));

import { __test__, messagingApi } from '../messagingApi';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.cryptoEnsureReady.mockResolvedValue({ state: 'ready' });
  mocks.waitForAccountSynchronization.mockResolvedValue(undefined);
  mocks.getAccountSynchronizationPhase.mockReturnValue('ready');
  mocks.startRealtime.mockReturnValue(vi.fn());
  mocks.startInbox.mockReturnValue(vi.fn());
});

describe('messagingApi readiness', () => {
  it('waits for an in-flight account sync before enforcing strict crypto readiness', async () => {
    const order: string[] = [];
    mocks.waitForAccountSynchronization.mockImplementation(async () => {
      order.push('account-sync');
    });
    mocks.cryptoEnsureReady.mockImplementation(async () => {
      order.push('crypto-ready');
      return { state: 'ready' };
    });

    await messagingApi.ensureReady('alice');

    expect(order).toEqual(['account-sync', 'crypto-ready']);
  });

  it('puts every send behind account synchronization and crypto readiness', async () => {
    mocks.sendOutbound.mockResolvedValue({ id: 'message-one' });

    await messagingApi.send({
      conversationId: 'conversation-one',
      senderUserId: 'alice',
      plaintext: 'secret',
    });

    expect(mocks.waitForAccountSynchronization).toHaveBeenCalledWith('alice');
    expect(mocks.cryptoEnsureReady).toHaveBeenCalledWith('alice');
    expect(mocks.sendOutbound).toHaveBeenCalledTimes(1);
  });
});

describe('messagingApi runtime recovery', () => {
  it('retries a transient startup failure and starts each runtime exactly once', async () => {
    vi.useFakeTimers();
    try {
      mocks.cryptoEnsureReady
        .mockRejectedValueOnce(new Error('temporary network failure'))
        .mockResolvedValue({ state: 'ready' });

      const cleanup = messagingApi.startRuntime('alice');
      await vi.waitFor(() => expect(mocks.cryptoEnsureReady).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(__test__.RUNTIME_RETRY_BASE_MS);
      await vi.waitFor(() => expect(mocks.startRealtime).toHaveBeenCalledTimes(1));

      expect(mocks.startInbox).toHaveBeenCalledTimes(1);
      cleanup();
      expect(mocks.startRealtime.mock.results[0].value).toHaveBeenCalledTimes(1);
      expect(mocks.startInbox.mock.results[0].value).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a scheduled retry during React cleanup', async () => {
    vi.useFakeTimers();
    try {
      mocks.cryptoEnsureReady.mockRejectedValue(new Error('offline'));
      const cleanup = messagingApi.startRuntime('alice');
      await vi.waitFor(() => expect(mocks.cryptoEnsureReady).toHaveBeenCalledTimes(1));

      cleanup();
      await vi.advanceTimersByTimeAsync(__test__.RUNTIME_RETRY_MAX_MS);

      expect(mocks.cryptoEnsureReady).toHaveBeenCalledTimes(1);
      expect(mocks.startRealtime).not.toHaveBeenCalled();
      expect(mocks.startInbox).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
