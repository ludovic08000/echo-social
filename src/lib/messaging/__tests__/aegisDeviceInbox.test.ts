import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  return {
    channel,
    ensureReady: vi.fn(),
    removeChannel: vi.fn(),
    rpc: vi.fn(),
    trace: vi.fn(),
  };
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    channel: vi.fn(() => mocks.channel),
    removeChannel: mocks.removeChannel,
  },
}));

vi.mock('@/lib/messaging/aegisTransport', () => ({
  callAegisServer: mocks.rpc,
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
  mocks.ensureReady.mockResolvedValue({
    deviceId: 'device-stable',
    expiresAt: Date.now() + 30_000,
    userId: 'user-one',
  });
});

describe('Aegis Server device inbox client', () => {
  it('shares an inbox synchronization and wakes the matching bubble', async () => {
    mocks.rpc.mockResolvedValue({
      data: [{
        copy_id: 'copy-one',
        message_id: 'message-one',
        conversation_id: 'conversation-one',
        sender_user_id: 'user-two',
        sender_device_id: 'device-two',
        encrypted_body: 'aegis1.ratchet.payload',
        parent_body: '{"protocol":"aegis-v1"}',
        image_url: null,
        document_url: null,
        document_name: null,
        document_mime: null,
        document_size_bytes: null,
        archive_body: null,
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
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('aegis_sync_device', {
      p_device_id: 'device-stable',
      p_limit: 100,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('forsure-decrypt-retry', listener);
  });

  it('deduplicates acknowledgements for a locally persisted message', async () => {
    mocks.rpc.mockResolvedValue({ data: 1, error: null });

    await Promise.all([
      acknowledgeAegisMessage('user-one', 'message-two'),
      acknowledgeAegisMessage('user-one', 'message-two'),
    ]);
    await acknowledgeAegisMessage('user-one', 'message-two');

    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('aegis_ack_device_messages', {
      p_device_id: 'device-stable',
      p_mark_read: false,
      p_message_ids: ['message-two'],
    });
  });

  it('does not cache a failed acknowledgement', async () => {
    mocks.rpc
      .mockResolvedValueOnce({ data: null, error: new Error('offline') })
      .mockResolvedValueOnce({ data: 1, error: null });

    await expect(acknowledgeAegisMessage('user-one', 'message-three'))
      .rejects.toThrow('offline');
    await expect(acknowledgeAegisMessage('user-one', 'message-three'))
      .resolves.toBeUndefined();

    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
});
