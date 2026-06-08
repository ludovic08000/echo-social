import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryReadDeviceCopy: vi.fn(),
  routeIncoming: vi.fn(),
  decryptArchive: vi.fn(),
  isArchivePayload: vi.fn(),
  archiveRows: new Map<string, { archive_body: string; conversation_id: string }>(),
}));

vi.mock('@/lib/messaging/multiDeviceFanout', () => ({
  tryReadDeviceCopy: mocks.tryReadDeviceCopy,
}));

vi.mock('@/e2ee-session', () => ({
  routeIncoming: mocks.routeIncoming,
}));

vi.mock('@/lib/crypto/plaintextStore', () => ({
  loadPlaintextForCiphertext: vi.fn().mockResolvedValue(null),
  savePlaintextForCiphertext: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/messaging/archive/archiveKey', () => ({
  decryptArchive: mocks.decryptArchive,
  isArchivePayload: mocks.isArchivePayload,
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'recipient-user' } } }),
    },
    from: vi.fn((table: string) => {
      if (table === 'messages') {
        return {
          select: () => ({
            in: (_column: string, ids: string[]) => Promise.resolve({
              data: ids.map((id) => ({ id, sender_id: 'sender-user' })),
            }),
            eq: (_column: string, id: string) => ({
              maybeSingle: () => Promise.resolve({
                data: mocks.archiveRows.get(id) ?? null,
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          in: () => Promise.resolve({ data: [] }),
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }),
        }),
      };
    }),
  },
}));

import { clearNegativeCache, resolvePlaintext } from '@/components/messages/decryptionService';

describe('decryptionService multi-device routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearNegativeCache();
    mocks.archiveRows.clear();
    mocks.tryReadDeviceCopy.mockResolvedValue(null);
    mocks.routeIncoming.mockResolvedValue({ ok: false, plaintext: null });
    mocks.decryptArchive.mockResolvedValue(null);
    mocks.isArchivePayload.mockReturnValue(false);
  });

  afterEach(() => {
    clearNegativeCache();
  });

  it('does not send multi-device parent envelopes through the legacy incoming router after copy miss', async () => {
    const body = JSON.stringify({
      encryptionMode: 'multi_device',
      v: 4,
      ct: 'device_copies',
      ts: Date.now(),
    });

    const result = resolvePlaintext({
      body,
      messageId: 'msg-missing-current-device-copy',
      decrypt: vi.fn().mockResolvedValue({ text: '', incompatible: true }),
    });

    await expect(result).resolves.toBeNull();

    expect(mocks.tryReadDeviceCopy).toHaveBeenCalledWith('msg-missing-current-device-copy', 'sender-user');
    expect(mocks.routeIncoming).not.toHaveBeenCalled();
  });

  it('uses encrypted archive fallback for multi-device parent envelopes when the device copy is missing', async () => {
    const body = JSON.stringify({
      encryptionMode: 'multi_device',
      v: 4,
      ct: 'device_copies',
      ts: Date.now(),
    });
    mocks.archiveRows.set('msg-archive-copy-miss', {
      archive_body: '{"v":1,"iv":"iv","ct":"ct"}',
      conversation_id: 'conversation-1',
    });
    mocks.isArchivePayload.mockReturnValue(true);
    mocks.decryptArchive.mockResolvedValue('dernier message clair');

    const result = await resolvePlaintext({
      body,
      messageId: 'msg-archive-copy-miss',
      decrypt: vi.fn().mockResolvedValue({ text: '', incompatible: true }),
    });

    expect(result?.text).toBe('dernier message clair');
    expect(mocks.tryReadDeviceCopy).toHaveBeenCalledWith('msg-archive-copy-miss', 'sender-user');
    expect(mocks.routeIncoming).not.toHaveBeenCalled();
    expect(mocks.decryptArchive).toHaveBeenCalledWith(
      '{"v":1,"iv":"iv","ct":"ct"}',
      'conversation-1',
      'recipient-user',
    );
  });
});
