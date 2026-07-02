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
  loadPlaintext: vi.fn().mockResolvedValue(null),
  loadPlaintextForCiphertext: vi.fn().mockResolvedValue(null),
  savePlaintext: vi.fn().mockResolvedValue(undefined),
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

  // Regression: multi-device messages are AEAD-authenticated by the ratchet
  // session but fail the *secondary* Ed25519 check because the sending device
  // signs with its own key while we only hold the peer's account-level signing
  // key. Such a result (`verified: false`, non-empty text) must be SURFACED,
  // not dropped to a blank bubble. This locks in the empty-bubble fix.
  it('surfaces a decrypted-but-unverified ratchet message instead of dropping it', async () => {
    const body = JSON.stringify({
      encryptionMode: 'ratchet',
      v: 4,
      iv: 'aXYtYnl0ZXM=',
      ct: 'Y2lwaGVydGV4dA==',
      sig: 'c2lnbmF0dXJl',
      fp: 'sender-device-fingerprint',
      ts: Date.now(),
      hdr: { dh: 'ZGgtcHVia2V5', n: 0, pn: 0 },
    });

    const result = await resolvePlaintext({
      body,
      messageId: 'msg-unverified-from-secondary-device',
      decrypt: vi.fn().mockResolvedValue({
        text: 'message from my other device',
        encrypted: true,
        verified: false,
      }),
    });

    expect(result).not.toBeNull();
    expect(result?.text).toBe('message from my other device');
    expect(result?.hidden).toBe(false);
    // Must not fall through to device-copy fallback — the primary decrypt
    // already produced usable plaintext.
    expect(mocks.tryReadDeviceCopy).not.toHaveBeenCalled();
  });
});
