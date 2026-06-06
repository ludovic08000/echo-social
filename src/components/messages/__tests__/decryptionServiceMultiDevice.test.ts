import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  tryReadDeviceCopy: vi.fn(),
  routeIncoming: vi.fn(),
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
  decryptArchive: vi.fn().mockResolvedValue(null),
  isArchivePayload: vi.fn().mockReturnValue(false),
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
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null }),
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
    mocks.tryReadDeviceCopy.mockResolvedValue(null);
    mocks.routeIncoming.mockResolvedValue({ ok: false, plaintext: null });
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
});
