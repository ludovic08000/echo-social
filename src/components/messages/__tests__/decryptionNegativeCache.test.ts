import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadPlaintext: vi.fn(),
  loadPlaintextForCiphertext: vi.fn(),
  savePlaintext: vi.fn(),
  savePlaintextForCiphertext: vi.fn(),
  tryReadDeviceCopy: vi.fn(),
  routeIncoming: vi.fn(),
  from: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock('@/lib/crypto/plaintextStore', () => ({
  loadPlaintext: mocks.loadPlaintext,
  loadPlaintextForCiphertext: mocks.loadPlaintextForCiphertext,
  savePlaintext: mocks.savePlaintext,
  savePlaintextForCiphertext: mocks.savePlaintextForCiphertext,
}));

vi.mock('@/lib/messaging/multiDeviceFanout', () => ({
  tryReadDeviceCopy: mocks.tryReadDeviceCopy,
}));

vi.mock('@/e2ee-session', () => ({
  routeIncoming: mocks.routeIncoming,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getUser: mocks.getUser },
    from: mocks.from,
  },
}));

vi.mock('@/lib/messaging/archive/archiveKey', () => ({
  decryptArchive: vi.fn(async () => null),
  isArchivePayload: vi.fn(() => false),
}));

import {
  clearLastGoodOutcome,
  clearNegativeCache,
  clearNegativeCacheForMessage,
  dropCache,
  looksEncrypted,
  resolvePlaintext,
} from '@/components/messages/decryptionService';

function ratchetBody(seed: string): string {
  return JSON.stringify({
    encryptionMode: 'ratchet',
    v: 4,
    hdr: { dh: `dh-${seed}`, pn: 0, n: 0 },
    iv: `iv-${seed}`,
    ct: `ct-${seed}`,
    sig: `sig-${seed}`,
    fp: `fp-${seed}`,
    ts: 1,
  });
}

function multiDeviceBody(seed: string): string {
  return JSON.stringify({
    encryptionMode: 'multi_device',
    v: 4,
    ct: 'device_copies',
    ts: 1,
    seed,
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
    clearNegativeCache();
    clearLastGoodOutcome();
    mocks.loadPlaintext.mockResolvedValue(null);
    mocks.loadPlaintextForCiphertext.mockResolvedValue(null);
    mocks.savePlaintext.mockResolvedValue(undefined);
    mocks.savePlaintextForCiphertext.mockResolvedValue(undefined);
    mocks.tryReadDeviceCopy.mockResolvedValue(null);
    mocks.routeIncoming.mockResolvedValue({ ok: false, plaintext: null });
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    mocks.from.mockImplementation((table: string) => {
      if (table !== 'messages') throw new Error(`Unexpected table: ${table}`);
      return {
        select: () => ({
          in: async (ids: string[]) => ({
            data: ids.map((id) => ({ id, sender_id: null })),
            error: null,
          }),
        }),
      };
    });
  });

  it('clears every body variant for one message without clearing another message', async () => {
    const bodyA1 = ratchetBody('a1');
    const bodyA2 = ratchetBody('a2');
    const bodyB = ratchetBody('b');
    const fail = vi.fn(async () => failedDecrypt());

    await Promise.all([
      resolvePlaintext({ body: bodyA1, messageId: 'message-a', decrypt: fail }),
      resolvePlaintext({ body: bodyA2, messageId: 'message-a', decrypt: fail }),
      resolvePlaintext({ body: bodyB, messageId: 'message-b', decrypt: fail }),
    ]);

    clearNegativeCacheForMessage('message-a');

    const recoverA1 = vi.fn(async () => ({
      text: 'restored-a1',
      incompatible: false,
      encrypted: true,
      verified: true,
    }));
    const recoverA2 = vi.fn(async () => ({
      text: 'restored-a2',
      incompatible: false,
      encrypted: true,
      verified: true,
    }));
    const recoverB = vi.fn(async () => ({
      text: 'must-not-run',
      incompatible: false,
      encrypted: true,
      verified: true,
    }));

    expect((await resolvePlaintext({ body: bodyA1, messageId: 'message-a', decrypt: recoverA1 }))?.text).toBe('restored-a1');
    expect((await resolvePlaintext({ body: bodyA2, messageId: 'message-a', decrypt: recoverA2 }))?.text).toBe('restored-a2');
    expect(await resolvePlaintext({ body: bodyB, messageId: 'message-b', decrypt: recoverB })).toBeNull();

    expect(recoverA1).toHaveBeenCalledOnce();
    expect(recoverA2).toHaveBeenCalledOnce();
    expect(recoverB).not.toHaveBeenCalled();
  });

  it('keeps the last authenticated plaintext when a later retry fails', async () => {
    const body = ratchetBody('sticky');
    const firstDecrypt = vi.fn(async () => ({
      text: 'Cette bulle doit rester visible',
      incompatible: false,
      encrypted: true,
      verified: true,
    }));

    const first = await resolvePlaintext({
      body,
      messageId: 'message-sticky',
      decrypt: firstDecrypt,
    });
    expect(first?.text).toBe('Cette bulle doit rester visible');

    dropCache('message-sticky', body);
    clearNegativeCacheForMessage('message-sticky');
    const retryDecrypt = vi.fn(async () => failedDecrypt());

    const retried = await resolvePlaintext({
      body,
      messageId: 'message-sticky',
      decrypt: retryDecrypt,
    });

    expect(retryDecrypt).toHaveBeenCalledOnce();
    expect(retried?.text).toBe('Cette bulle doit rester visible');
  });

  it('retries sender lookup after a transient empty realtime result', async () => {
    const body = multiDeviceBody('sender-retry');
    let senderLookupCount = 0;

    mocks.from.mockImplementation((table: string) => {
      if (table !== 'messages') throw new Error(`Unexpected table: ${table}`);
      return {
        select: (columns: string) => {
          if (columns === 'id,sender_id') {
            return {
              in: async (ids: string[]) => {
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
    mocks.tryReadDeviceCopy.mockResolvedValueOnce('copie Sesame récupérée');

    const second = await resolvePlaintext({
      body,
      messageId: 'message-sender-retry',
      decrypt: vi.fn(async () => failedDecrypt()),
    });

    expect(senderLookupCount).toBe(2);
    expect(mocks.tryReadDeviceCopy).toHaveBeenCalledWith('message-sender-retry', 'sender-user');
    expect(second?.text).toBe('copie Sesame récupérée');
  });

  it('uses a known sender id without waiting for a sender lookup query', async () => {
    const body = multiDeviceBody('known-sender');
    mocks.tryReadDeviceCopy.mockResolvedValueOnce('copie directe');

    const result = await resolvePlaintext({
      body,
      messageId: 'message-known-sender',
      senderId: 'sender-known',
      decrypt: vi.fn(async () => failedDecrypt()),
    });

    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.tryReadDeviceCopy).toHaveBeenCalledWith('message-known-sender', 'sender-known');
    expect(result?.text).toBe('copie directe');
  });

  it('treats future crypto JSON envelopes as encrypted recovery rows', () => {
    expect(looksEncrypted(JSON.stringify({
      encryptionMode: 'future_device_mode',
      v: 99,
      ct: 'opaque-ciphertext',
    }))).toBe(true);
  });
});
