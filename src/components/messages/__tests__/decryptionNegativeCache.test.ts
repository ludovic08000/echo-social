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
  clearNegativeCache,
  clearNegativeCacheForMessage,
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

describe('targeted decryption negative cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearNegativeCache();
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
    const fail = vi.fn(async () => ({
      text: '',
      incompatible: true,
      encrypted: true,
      verified: false,
    }));

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
});
