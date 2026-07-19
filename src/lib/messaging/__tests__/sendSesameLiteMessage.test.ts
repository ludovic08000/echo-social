import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureIdentity: vi.fn(),
  savePlaintext: vi.fn(),
  savePlaintextForCiphertext: vi.fn(),
  rollback: vi.fn(),
  buildCopies: vi.fn(),
  putOutbox: vi.fn(),
  deleteOutbox: vi.fn(),
  sendRpc: vi.fn(),
}));

vi.mock('@/e2ee-session', () => ({ safeUUID: vi.fn(() => crypto.randomUUID()) }));
vi.mock('@/lib/crypto/identityBootstrap', () => ({
  ensureUserE2EEIdentity: mocks.ensureIdentity,
}));
vi.mock('@/lib/crypto/plaintextStore', () => ({
  savePlaintext: mocks.savePlaintext,
  savePlaintextForCiphertext: mocks.savePlaintextForCiphertext,
}));
vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: vi.fn(() => 'sender-device'),
}));
vi.mock('@/lib/messaging/fanoutSessionTransaction', () => ({
  rollbackFanoutSessionTransaction: mocks.rollback,
}));
vi.mock('@/lib/messaging/longMessageAttachment', () => ({
  MAX_INLINE_MESSAGE_BODY_BYTES: 2048,
  utf8ByteLength: (value: string) => new TextEncoder().encode(value).byteLength,
  prepareLongMessageForSend: vi.fn(),
}));
vi.mock('@/lib/messaging/multiDeviceFanout', () => ({
  buildFanoutCopies: mocks.buildCopies,
}));
vi.mock('@/lib/messaging/outboxVault', () => ({
  putOutboxPayload: mocks.putOutbox,
  deleteOutboxPayload: mocks.deleteOutbox,
}));
vi.mock('@/lib/messaging/sesameSendRpc', () => ({
  sendMessageWithSesameRetry: mocks.sendRpc,
}));
vi.mock('@/lib/messaging/signalWebConversationQueue', () => ({
  runSignalConversationJob: vi.fn((_key: string, job: () => Promise<unknown>) => job()),
}));

import {
  buildSesameLiteParentEnvelope,
  sendSesameLiteMessage,
} from '@/lib/messaging/sendSesameLiteMessage';
import {
  isMultiDeviceEnvelopeBody,
  SESAME_LITE_PROTOCOL,
} from '@/lib/messaging/messageCompatibility';

const COPY = {
  message_id: '11111111-1111-4111-8111-111111111111',
  recipient_user_id: '22222222-2222-4222-8222-222222222222',
  recipient_device_id: 'recipient-device',
  sender_user_id: '33333333-3333-4333-8333-333333333333',
  sender_device_id: 'sender-device',
  encrypted_body: 'x3dh5.session.dh.0.0.iv.ct',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureIdentity.mockResolvedValue(undefined);
  mocks.savePlaintext.mockResolvedValue(undefined);
  mocks.savePlaintextForCiphertext.mockResolvedValue(undefined);
  mocks.rollback.mockResolvedValue(1);
  mocks.putOutbox.mockResolvedValue(undefined);
  mocks.deleteOutbox.mockResolvedValue(undefined);
  mocks.buildCopies.mockResolvedValue({ rows: [COPY], hasTargets: true });
  mocks.sendRpc.mockResolvedValue({
    data: COPY.message_id,
    error: null,
    copies: [COPY],
    retriedStaleRoute: false,
  });
});

describe('sendSesameLiteMessage', () => {
  it('persists exact device copies before the atomic RPC and then clears the outbox', async () => {
    const result = await sendSesameLiteMessage({
      conversationId: '44444444-4444-4444-8444-444444444444',
      senderUserId: COPY.sender_user_id,
      plaintext: 'message secret',
      localId: 'local-one',
      traceId: 'trace-one',
      messageId: COPY.message_id,
    });

    expect(isMultiDeviceEnvelopeBody(result.parentBody)).toBe(true);
    expect(JSON.parse(result.parentBody).protocol).toBe(SESAME_LITE_PROTOCOL);
    expect(mocks.putOutbox).toHaveBeenCalledTimes(2);
    expect(mocks.putOutbox.mock.calls[1][1]).toMatchObject({
      localId: 'local-one',
      reservedServerId: COPY.message_id,
      transportPlaintext: 'message secret',
      preparedCopies: [COPY],
      status: 'sending',
    });
    expect(mocks.putOutbox.mock.invocationCallOrder[1])
      .toBeLessThan(mocks.sendRpc.mock.invocationCallOrder[0]);
    expect(mocks.sendRpc).toHaveBeenCalledWith(expect.objectContaining({
      messageId: COPY.message_id,
      senderDeviceId: 'sender-device',
      initialCopies: [COPY],
      extra: { body_kind: 'multi_device' },
    }));
    expect(mocks.deleteOutbox).toHaveBeenCalledWith('local-one');
  });

  it('never calls the server without a recipient-device copy', async () => {
    mocks.buildCopies.mockResolvedValue({ rows: [], hasTargets: false });

    await expect(sendSesameLiteMessage({
      conversationId: '44444444-4444-4444-8444-444444444444',
      senderUserId: COPY.sender_user_id,
      plaintext: 'message secret',
      localId: 'local-two',
      traceId: 'trace-two',
      messageId: COPY.message_id,
    })).rejects.toThrow('E2EE_DEVICE_COPIES_UNAVAILABLE');

    expect(mocks.sendRpc).not.toHaveBeenCalled();
    expect(mocks.rollback).toHaveBeenCalledWith(COPY.message_id);
    expect(mocks.putOutbox).toHaveBeenLastCalledWith(
      COPY.sender_user_id,
      expect.objectContaining({
        localId: 'local-two',
        preparedCopies: [],
        status: 'retry_pending',
      }),
    );
  });

  it('builds only the current strict parent marker', () => {
    const parent = buildSesameLiteParentEnvelope('local-three', 'trace-three');
    expect(isMultiDeviceEnvelopeBody(parent)).toBe(true);
    expect(parent).not.toContain('ratchet');
    expect(parent).not.toContain('secure_pipeline');
  });
});
