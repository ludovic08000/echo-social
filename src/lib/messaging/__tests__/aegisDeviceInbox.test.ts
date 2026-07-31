import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);

  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);

  return {
    channel,
    ensureReady: vi.fn(),
    from: vi.fn(() => query),
    limit: query.limit,
    query,
    removeChannel: vi.fn(),
    rpc: vi.fn(),
    trace: vi.fn(),
  };
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    channel: vi.fn(() => mocks.channel),
    from: mocks.from,
    removeChannel: mocks.removeChannel,
    rpc: mocks.rpc,
  },
}));

vi.mock('@/lib/messaging/aegisDeviceRuntime', () => ({
  ensureAegisDeviceReady: mocks.ensureReady,
}));

vi.mock('@/lib/messaging/e2eeTrace', () => ({
  traceE2EE: mocks.trace,
}));

import {
  acknowledgeAegisMessage,
  syncAegisDeviceInbox,
} from '@/lib/messaging/aegisDeviceInbox';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.channel.on.mockReturnValue(mocks.channel);
  mocks.channel.subscribe.mockReturnValue(mocks.channel);
  mocks.query.select.mockReturnValue(mocks.query);
  mocks.query.eq.mockReturnValue(mocks.query);
  mocks.query.order.mockReturnValue(mocks.query);
  mocks.ensureReady.mockResolvedValue({
    deviceId: 'device-stable',
    expiresAt: Date.now() + 30_000,
    userId: 'user-one',
  });
  mocks.limit.mockResolvedValue({ data: [], error: null });
});

describe('Aegis final-schema device inbox client', () => {
  it('shares one synchronization and wakes the matching bubble', async () => {
    mocks.limit.mockResolvedValue({
      data: [{ message_id: 'message-one' }],
      error: null,
    });
    mocks.rpc.mockResolvedValue({
      data: [{
        message_id: 'message-one',
        sender_user_id: 'user-two',
        sender_device_id: 'device-two',
        recipient_device_id: 'device-stable',
        encrypted_body: 'aegis1.ratchet.payload',
        created_at: new Date().toISOString(),
      }],
      error: null,
    });
    const listener = vi.fn();
    window.addEventListener('forsure-decrypt-retry', listener);

    const [first, second] = await Promise.all([
      syncAegisDeviceInbox('user-one'),
      syncAegisDeviceInbox('user-one'),
    ]);

    expect(first).toEqual(second);
    expect(mocks.from).toHaveBeenCalledWith('message_device_copies');
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('get_device_copies_for_messages', {
      p_message_ids: ['message-one'],
      p_device_id: 'device-stable',
    });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('forsure-decrypt-retry', listener);
  });

  it('deduplicates a local authenticated-decryption acknowledgement', async () => {
    await Promise.all([
      acknowledgeAegisMessage('user-one', 'message-two'),
      acknowledgeAegisMessage('user-one', 'message-two'),
    ]);
    await acknowledgeAegisMessage('user-one', 'message-two');

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.trace).toHaveBeenCalledTimes(1);
    expect(mocks.trace).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'receive',
      stage: 'MESSAGE_DECRYPTED_LOCAL',
      messageId: 'message-two',
    }));
  });

  it('tracks delivered and read state separately without an obsolete server RPC', async () => {
    await acknowledgeAegisMessage('user-one', 'message-three');
    await acknowledgeAegisMessage('user-one', 'message-three', true);
    await acknowledgeAegisMessage('user-one', 'message-three', true);

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.trace).toHaveBeenCalledTimes(2);
    expect(mocks.trace).toHaveBeenNthCalledWith(1, expect.objectContaining({
      stage: 'MESSAGE_DECRYPTED_LOCAL',
      messageId: 'message-three',
    }));
    expect(mocks.trace).toHaveBeenNthCalledWith(2, expect.objectContaining({
      stage: 'MESSAGE_READ_LOCAL',
      messageId: 'message-three',
    }));
  });

  it('releases the shared synchronization after a reference-query failure', async () => {
    mocks.limit
      .mockResolvedValueOnce({ data: null, error: new Error('offline') })
      .mockResolvedValueOnce({ data: [], error: null });

    await expect(syncAegisDeviceInbox('user-one')).rejects.toThrow('offline');
    await expect(syncAegisDeviceInbox('user-one')).resolves.toEqual([]);

    expect(mocks.limit).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
