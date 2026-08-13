import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);

  return {
    callAegisServer: vi.fn(),
    channel,
    ensureReady: vi.fn(),
    removeChannel: vi.fn(),
    trace: vi.fn(),
    transportKind: vi.fn(),
    stageCopy: vi.fn(),
  };
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    channel: vi.fn(() => mocks.channel),
    removeChannel: mocks.removeChannel,
  },
}));

vi.mock('@/lib/messaging/aegisDeviceRuntime', () => ({
  ensureAegisDeviceReady: mocks.ensureReady,
}));

vi.mock('@/lib/messaging/aegisTransport', () => ({
  callAegisServer: mocks.callAegisServer,
  getAegisTransportKind: mocks.transportKind,
}));

vi.mock('@/lib/messaging/e2eeTrace', () => ({
  traceE2EE: mocks.trace,
}));

vi.mock('@/lib/messaging/multiDeviceFanout', () => ({
  stageSyncedDeviceCopy: mocks.stageCopy,
}));

import {
  acknowledgeAegisMessage,
  formatAegisInboxError,
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
  mocks.transportKind.mockReturnValue('supabase');
  mocks.callAegisServer.mockResolvedValue({ data: [], error: null });
});

describe('Aegis durable device inbox client', () => {
  it('shares one server synchronization and wakes the matching bubble', async () => {
    const row = {
      copy_id: 'copy-one',
      message_id: 'message-one',
      conversation_id: 'conversation-one',
      sender_user_id: 'user-two',
      sender_device_id: 'device-two',
      recipient_device_id: 'device-stable',
      encrypted_body: 'aegis1.ratchet.payload',
      parent_body: '{"encryptionMode":"multi_device"}',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    mocks.callAegisServer.mockResolvedValue({ data: [row], error: null });
    const listener = vi.fn();
    window.addEventListener('forsure-decrypt-retry', listener);

    const [first, second] = await Promise.all([
      syncAegisDeviceInbox('user-one'),
      syncAegisDeviceInbox('user-one'),
    ]);

    expect(first).toEqual([row]);
    expect(second).toEqual(first);
    expect(mocks.callAegisServer).toHaveBeenCalledTimes(1);
    expect(mocks.callAegisServer).toHaveBeenCalledWith('aegis_sync_device', {
      p_device_id: 'device-stable',
      p_limit: 100,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mocks.stageCopy).toHaveBeenCalledWith('user-one', 'device-stable', {
      message_id: 'message-one',
      encrypted_body: 'aegis1.ratchet.payload',
      sender_user_id: 'user-two',
      sender_device_id: 'device-two',
      recipient_device_id: 'device-stable',
    });
    window.removeEventListener('forsure-decrypt-retry', listener);
  });

  it('re-stages a still-pending capsule until decrypt and ACK succeed', async () => {
    const row = {
      copy_id: 'copy-retry', message_id: 'message-retry', conversation_id: 'conversation-one',
      sender_user_id: 'user-two', sender_device_id: 'device-two', recipient_device_id: 'device-stable',
      encrypted_body: 'aegis1.init.v1.payload', parent_body: '{}',
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    mocks.callAegisServer.mockResolvedValue({ data: [row], error: null });

    await syncAegisDeviceInbox('user-one');
    await syncAegisDeviceInbox('user-one');

    expect(mocks.stageCopy).toHaveBeenCalledTimes(2);
    expect(mocks.callAegisServer).toHaveBeenCalledTimes(2);
  });

  it('preserves PostgREST error details instead of reporting E_UNKNOWN', () => {
    expect(formatAegisInboxError({
      code: 'PGRST202',
      message: 'Could not find the function in the schema cache',
      details: 'Reload the PostgREST schema',
    })).toBe(
      'PGRST202: Could not find the function in the schema cache: Reload the PostgREST schema',
    );
    expect(formatAegisInboxError(new Error('offline'))).toBe('offline');
    expect(formatAegisInboxError('network aborted')).toBe('network aborted');
    expect(formatAegisInboxError(null)).toBe('UNKNOWN');
  });

  it('deduplicates a durable authenticated-decryption acknowledgement', async () => {
    mocks.callAegisServer.mockResolvedValue({ data: 1, error: null });

    await Promise.all([
      acknowledgeAegisMessage('user-one', 'message-two'),
      acknowledgeAegisMessage('user-one', 'message-two'),
    ]);
    await acknowledgeAegisMessage('user-one', 'message-two');

    expect(mocks.callAegisServer).toHaveBeenCalledTimes(1);
    expect(mocks.callAegisServer).toHaveBeenCalledWith(
      'aegis_ack_device_messages',
      {
        p_device_id: 'device-stable',
        p_message_ids: ['message-two'],
        p_mark_read: false,
      },
    );
    expect(mocks.trace).toHaveBeenCalledTimes(1);
    expect(mocks.trace).toHaveBeenCalledWith(expect.objectContaining({
      direction: 'receive',
      stage: 'SERVER_INBOX_DURABLE_ACK',
      messageId: 'message-two',
    }));
  });

  it('tracks durable delivered and read acknowledgement separately', async () => {
    mocks.callAegisServer.mockResolvedValue({ data: 1, error: null });

    await acknowledgeAegisMessage('user-one', 'message-three');
    await acknowledgeAegisMessage('user-one', 'message-three', true);
    await acknowledgeAegisMessage('user-one', 'message-three', true);

    expect(mocks.callAegisServer).toHaveBeenCalledTimes(2);
    expect(mocks.callAegisServer).toHaveBeenNthCalledWith(
      1,
      'aegis_ack_device_messages',
      expect.objectContaining({ p_mark_read: false }),
    );
    expect(mocks.callAegisServer).toHaveBeenNthCalledWith(
      2,
      'aegis_ack_device_messages',
      expect.objectContaining({ p_mark_read: true }),
    );
    expect(mocks.trace).toHaveBeenCalledTimes(2);
    expect(mocks.trace).toHaveBeenNthCalledWith(1, expect.objectContaining({
      stage: 'SERVER_INBOX_DURABLE_ACK',
      messageId: 'message-three',
    }));
    expect(mocks.trace).toHaveBeenNthCalledWith(2, expect.objectContaining({
      stage: 'MESSAGE_READ_LOCAL',
      messageId: 'message-three',
    }));
  });

  it('releases the shared synchronization after a server failure', async () => {
    mocks.callAegisServer
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ data: [], error: null });

    await expect(syncAegisDeviceInbox('user-one')).rejects.toThrow('offline');
    await expect(syncAegisDeviceInbox('user-one')).resolves.toEqual([]);

    expect(mocks.callAegisServer).toHaveBeenCalledTimes(2);
  });

  it('does not share an in-flight synchronization across users or devices', async () => {
    mocks.ensureReady.mockImplementation(async (userId: string) => ({
      deviceId: `device-${userId}`,
      expiresAt: Date.now() + 30_000,
      userId,
    }));

    await Promise.all([
      syncAegisDeviceInbox('user-one'),
      syncAegisDeviceInbox('user-two'),
    ]);

    expect(mocks.callAegisServer).toHaveBeenCalledTimes(2);
    expect(mocks.callAegisServer).toHaveBeenCalledWith('aegis_sync_device', {
      p_device_id: 'device-user-one',
      p_limit: 100,
    });
    expect(mocks.callAegisServer).toHaveBeenCalledWith('aegis_sync_device', {
      p_device_id: 'device-user-two',
      p_limit: 100,
    });
  });

  it('rejects a device runtime resolved for another user', async () => {
    mocks.ensureReady.mockResolvedValue({
      deviceId: 'device-other',
      expiresAt: Date.now() + 30_000,
      userId: 'user-other',
    });

    await expect(syncAegisDeviceInbox('user-one'))
      .rejects.toThrow('AEGIS_DEVICE_USER_MISMATCH');
    expect(mocks.callAegisServer).not.toHaveBeenCalled();
  });
});
