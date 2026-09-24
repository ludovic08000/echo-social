import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadPlaintext: vi.fn(),
  loadPlaintextForCiphertext: vi.fn(),
  savePlaintext: vi.fn(),
  savePlaintextForCiphertext: vi.fn(),
  tryReadDeviceCopy: vi.fn(),
  routeIncoming: vi.fn(),
  openAegisMessage: vi.fn(),
  from: vi.fn(),
  getUser: vi.fn(),
  archiveBubbleForUser: vi.fn(),
  acknowledgeAegisMessage: vi.fn(),
}));

vi.mock('@/lib/crypto/plaintextStore', () => ({
  loadPlaintext: mocks.loadPlaintext,
  loadPlaintextForCiphertext: mocks.loadPlaintextForCiphertext,
  savePlaintext: mocks.savePlaintext,
  savePlaintextForCiphertext: mocks.savePlaintextForCiphertext,
}));

vi.mock('@/lib/messaging/multiDeviceFanout', () => ({
  tryReadDeviceCopy: mocks.tryReadDeviceCopy,
  clearDeviceCopyCache: vi.fn(),
  clearDeviceCopyCacheForMessage: vi.fn(),
}));

vi.mock('@/e2ee-session', () => ({
  routeIncoming: mocks.routeIncoming,
}));

vi.mock('@/lib/messaging/aegisEnvelope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/messaging/aegisEnvelope')>();
  return {
    ...actual,
    openAegisMessage: mocks.openAegisMessage,
  };
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  },
}));

vi.mock('@/lib/messaging/archive/archiveKey', () => ({
  decryptArchive: vi.fn(async () => null),
  isArchivePayload: vi.fn(() => false),
  archiveBubbleForUser: mocks.archiveBubbleForUser,
  recoverBubbleFromArchive: vi.fn(async () => null),
}));

vi.mock('@/lib/messaging/aegisDeviceInbox', () => ({
  acknowledgeAegisMessage: mocks.acknowledgeAegisMessage,
}));

import {
  clearLastGoodOutcome,
  clearDecryptionSessionCaches,
  clearNegativeCache,
  clearNegativeCacheForMessage,
  dropCache,
  looksEncrypted,
  resolvePlaintext,
} from '@/components/messages/decryptionService';
import { primeAuthUserId } from '@/lib/crypto/peerKeyCache';

function multiDeviceBody(messageId: string, seed: string): string {
  return JSON.stringify({
    protocol: 'forsure-aegis-message',
    version: 1,
    encryptionMode: 'multi_device',
    algorithm: 'AES-256-GCM',
    keyTransport: 'device_ratchet',
    messageId,
    conversationId: 'conversation-id',
    senderId: 'sender',
    iv: 'aXYtYnl0ZXM=',
    ciphertext: seed,
    digest: `digest-${seed}`,
    createdAt: 1,
  });
}

function failedDecrypt() {
  return {
    text: '',
    incompatible: true,
    encrypted: true,
    verified: false,
  };
}

describe('targeted decryption cache and Bubble Hold', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearDecryptionSessionCaches();
    clearNegativeCache();
    clearLastGoodOutcome();
    primeAuthUserId(null);
    localStorage.clear();
    mocks.loadPlaintext.mockResolvedValue(null);
    mocks.loadPlaintextForCiphertext.mockResolvedValue(null);
    mocks.savePlaintext.mockResolvedValue(undefined);
    mocks.savePlaintextForCiphertext.mockResolvedValue(undefined);
    mocks.tryReadDeviceCopy.mockResolvedValue(null);
    mocks.routeIncoming.mockResolvedValue({ ok: false, plaintext: null });
    mocks.openAegisMessage.mockImplementation(async (_body: string, capsule: string) => capsule);
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    mocks.archiveBubbleForUser.mockResolvedValue(true);
    mocks.acknowledgeAegisMessage.mockResolvedValue(undefined);
    mocks.from.mockImplementation((table: string) => {
      if (table !== 'messages') throw new Error(`Unexpected table: ${table}`);
      return {
        select: () => ({
          in: async (_column: string, ids: string[]) => ({
            data: ids.map((id) => ({ id, sender_id: null })),
            error: null,
          }),
        }),
      };
    });
  });

  it('clears every body variant for one message without clearing another message', async () => {
    const bodyA1 = multiDeviceBody('message-a', 'a1');
    const bodyA2 = multiDeviceBody('message-a', 'a2');
    const bodyB = multiDeviceBody('message-b', 'b');
    const fail = vi.fn(async () => failedDecrypt());

    await Promise.all([
      resolvePlaintext({ body: bodyA1, messageId: 'message-a', senderId: 'sender', decrypt: fail }),
      resolvePlaintext({ body: bodyA2, messageId: 'message-a', senderId: 'sender', decrypt: fail }),
      resolvePlaintext({ body: bodyB, messageId: 'message-b', senderId: 'sender', decrypt: fail }),
    ]);

    clearNegativeCacheForMessage('message-a');
    mocks.tryReadDeviceCopy.mockResolvedValue('restored-a');

    expect((await resolvePlaintext({ body: bodyA1, messageId: 'message-a', senderId: 'sender', decrypt: fail }))?.text).toBe('restored-a');
    expect((await resolvePlaintext({ body: bodyA2, messageId: 'message-a', senderId: 'sender', decrypt: fail }))?.text).toBe('restored-a');
    expect(await resolvePlaintext({ body: bodyB, messageId: 'message-b', senderId: 'sender', decrypt: fail })).toBeNull();
  });

  it('keeps the last authenticated plaintext when a later retry fails', async () => {
    const body = multiDeviceBody('message-sticky', 'sticky');
    const firstDecrypt = vi.fn(async () => failedDecrypt());
    mocks.tryReadDeviceCopy.mockResolvedValueOnce('Cette bulle doit rester visible');

    const first = await resolvePlaintext({
      body,
      messageId: 'message-sticky',
      senderId: 'sender',
      decrypt: firstDecrypt,
    });
    expect(first?.text).toBe('Cette bulle doit rester visible');

    dropCache('message-sticky', body);
    clearNegativeCacheForMessage('message-sticky');
    const retryDecrypt = vi.fn(async () => failedDecrypt());
    mocks.tryReadDeviceCopy.mockResolvedValueOnce(null);

    const retried = await resolvePlaintext({
      body,
      messageId: 'message-sticky',
      senderId: 'sender',
      decrypt: retryDecrypt,
    });

    expect(retryDecrypt).not.toHaveBeenCalled();
    expect(retried?.text).toBe('Cette bulle doit rester visible');
  });

  it('retries sender lookup after a transient empty realtime result', async () => {
    const body = multiDeviceBody('message-sender-retry', 'sender-retry');
    let senderLookupCount = 0;

    mocks.from.mockImplementation((table: string) => {
      if (table !== 'messages') throw new Error(`Unexpected table: ${table}`);
      return {
        select: (columns: string) => {
          if (columns === 'id,sender_id') {
            return {
              in: async (_column: string, ids: string[]) => {
                senderLookupCount += 1;
                return {
                  data: ids.map((id) => ({
                    id,
                    sender_id: senderLookupCount === 1 ? null : 'sender-user',
                  })),
                  error: null,
                };
              },
            };
          }
          return {
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          };
        },
      };
    });

    const first = await resolvePlaintext({
      body,
      messageId: 'message-sender-retry',
      decrypt: vi.fn(async () => failedDecrypt()),
    });
    expect(first).toBeNull();
    expect(senderLookupCount).toBe(1);

    clearNegativeCacheForMessage('message-sender-retry');
    mocks.tryReadDeviceCopy.mockResolvedValueOnce('copie Aegis récupérée');

    const second = await resolvePlaintext({
      body,
      messageId: 'message-sender-retry',
      decrypt: vi.fn(async () => failedDecrypt()),
    });

    expect(senderLookupCount).toBe(2);
    expect(mocks.tryReadDeviceCopy).toHaveBeenCalledWith(
      'message-sender-retry',
      'sender-user',
      { requestRetry: true },
    );
    expect(second?.text).toBe('copie Aegis récupérée');
  });

  it('uses a known sender id without waiting for a sender lookup query', async () => {
    const body = multiDeviceBody('message-known-sender', 'known-sender');
    mocks.tryReadDeviceCopy.mockResolvedValueOnce('copie directe');

    const result = await resolvePlaintext({
      body,
      messageId: 'message-known-sender',
      senderId: 'sender-known',
      decrypt: vi.fn(async () => failedDecrypt()),
    });

    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.tryReadDeviceCopy).toHaveBeenCalledWith(
      'message-known-sender',
      'sender-known',
      { requestRetry: true },
    );
    expect(result?.text).toBe('copie directe');
  });

  it('backfills a disk-cached recipient message before acknowledging its server capsule', async () => {
    const body = multiDeviceBody('message-disk-backfill', 'disk-backfill');
    mocks.loadPlaintext.mockResolvedValueOnce('message déjà déchiffré localement');
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'recipient-user' } } });

    const result = await resolvePlaintext({
      body,
      messageId: 'message-disk-backfill',
      senderId: 'sender',
      isMe: false,
      decrypt: vi.fn(async () => failedDecrypt()),
    });

    expect(result?.text).toBe('message déjà déchiffré localement');
    await vi.waitFor(() => {
      expect(mocks.archiveBubbleForUser).toHaveBeenCalledWith({
        messageId: 'message-disk-backfill',
        conversationId: 'conversation-id',
        userId: 'recipient-user',
        plaintext: 'message déjà déchiffré localement',
        ensureParent: false,
      });
      expect(mocks.acknowledgeAegisMessage).toHaveBeenCalledWith(
        'recipient-user',
        'message-disk-backfill',
      );
    });
    expect(mocks.archiveBubbleForUser.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.acknowledgeAegisMessage.mock.invocationCallOrder[0]);
  });

  it('keeps the server capsule pending when archive durability cannot be verified', async () => {
    const body = multiDeviceBody('message-archive-retry', 'archive-retry');
    mocks.loadPlaintext.mockResolvedValueOnce('message à retenter');
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'recipient-user' } } });
    mocks.archiveBubbleForUser.mockResolvedValueOnce(false);

    await expect(resolvePlaintext({
      body,
      messageId: 'message-archive-retry',
      senderId: 'sender',
      isMe: false,
      decrypt: vi.fn(async () => failedDecrypt()),
    })).resolves.toEqual(expect.objectContaining({ text: 'message à retenter' }));

    await vi.waitFor(() => expect(mocks.archiveBubbleForUser).toHaveBeenCalled());
    expect(mocks.acknowledgeAegisMessage).not.toHaveBeenCalled();
  });

  it('treats future crypto JSON envelopes as encrypted recovery rows', () => {
    expect(looksEncrypted(JSON.stringify({
      encryptionMode: 'future_device_mode',
      v: 99,
      ct: 'opaque-ciphertext',
    }))).toBe(true);
  });
});
