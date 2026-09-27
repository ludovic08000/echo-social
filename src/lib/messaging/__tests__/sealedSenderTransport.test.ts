import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  fetch: vi.fn(),
  rpc: vi.fn(),
  selectResult: { data: [] as Array<{ id: string; context_id: string | null }>, error: null as unknown },
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: { invoke: mocks.invoke },
    rpc: mocks.rpc,
    from: vi.fn(() => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        order: vi.fn(() => builder),
        limit: vi.fn(async () => mocks.selectResult),
      };
      return builder;
    }),
  },
}));

import {
  acknowledgeSealedSenderWakeups,
  publishSealedSenderWakeups,
  pullSealedSenderWakeups,
} from '@/lib/messaging/sealedSenderTransport';

const SENDER = '11111111-1111-4111-8111-111111111111';
const RECIPIENT_ONE = '22222222-2222-4222-8222-222222222222';
const RECIPIENT_TWO = '33333333-3333-4333-8333-333333333333';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const MESSAGE = '55555555-5555-4555-8555-555555555555';

function copy(recipientUserId: string, device: string) {
  return {
    message_id: MESSAGE,
    recipient_user_id: recipientUserId,
    recipient_device_id: device,
    sender_user_id: SENDER,
    sender_device_id: 'sender-device',
    encrypted_body: 'opaque-libsignal-copy',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://project.example');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'publishable-test-key');
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.invoke.mockImplementation(async (_name: string, options: { body: Record<string, string> }) => ({
    data: {
      token: `signed-${options.body.recipient_user_id}`,
      recipient_user_id: options.body.recipient_user_id,
      conversation_id: options.body.conversation_id,
    },
    error: null,
  }));
  mocks.fetch.mockResolvedValue(new Response('{}', { status: 201 }));
  mocks.rpc.mockResolvedValue({ data: 1, error: null });
  mocks.selectResult = { data: [], error: null };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('Sealed Sender client transport', () => {
  it('mints once per recipient and relays without the sender authorization', async () => {
    const result = await publishSealedSenderWakeups({
      messageId: MESSAGE,
      conversationId: CONVERSATION,
      senderUserId: SENDER,
      copies: [
        copy(RECIPIENT_ONE, 'device-one'),
        copy(RECIPIENT_ONE, 'device-two'),
        copy(RECIPIENT_TWO, 'device-three'),
        copy(SENDER, 'sender-secondary-device'),
      ],
    });

    expect(result).toEqual({ attempted: 2, relayed: 2, failed: 0 });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenCalledWith('sealed-mint-token', {
      body: {
        recipient_user_id: RECIPIENT_ONE,
        conversation_id: CONVERSATION,
        context_id: MESSAGE,
      },
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of mocks.fetch.mock.calls as Array<[string, RequestInit]>) {
      const headers = init.headers as Record<string, string>;
      expect(headers.apikey).toBe('publishable-test-key');
      expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('authorization');
      const body = JSON.parse(String(init.body));
      expect(body).not.toHaveProperty('sender_user_id');
      expect(JSON.stringify(body)).not.toContain(SENDER);
      expect(body.sealed_header).toEqual({
        kind: 'aegis_inbox_wakeup',
        protocol: 'sealed_sender',
      });
    }
  });

  it('keeps relay failures non-fatal for the canonical Aegis send', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('offline'));

    await expect(publishSealedSenderWakeups({
      messageId: MESSAGE,
      conversationId: CONVERSATION,
      senderUserId: SENDER,
      copies: [copy(RECIPIENT_ONE, 'device-one')],
    })).resolves.toEqual({ attempted: 1, relayed: 0, failed: 1 });
  });

  it('bounds token mint latency without blocking the canonical Aegis send', async () => {
    vi.useFakeTimers();
    mocks.invoke.mockImplementation(() => new Promise(() => undefined));

    const pending = publishSealedSenderWakeups({
      messageId: MESSAGE,
      conversationId: CONVERSATION,
      senderUserId: SENDER,
      copies: [copy(RECIPIENT_ONE, 'device-one')],
    });
    await vi.advanceTimersByTimeAsync(4_000);

    await expect(pending).resolves.toEqual({ attempted: 1, relayed: 0, failed: 1 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('pulls only queued wakeups and acknowledges them through the scoped RPC', async () => {
    mocks.selectResult = {
      data: [{ id: '66666666-6666-4666-8666-666666666666', context_id: MESSAGE }],
      error: null,
    };

    const wakeups = await pullSealedSenderWakeups();
    await acknowledgeSealedSenderWakeups(wakeups.map((wakeup) => wakeup.id));

    expect(wakeups).toHaveLength(1);
    expect(mocks.rpc).toHaveBeenCalledWith('ack_sealed_sender_wakeups', {
      p_message_ids: ['66666666-6666-4666-8666-666666666666'],
    });
  });
});
