import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  supabaseFrom: vi.fn(),
  supabaseRpc: vi.fn(),
  listFanoutTargets: vi.fn(),
  ratchetEncrypt: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mocks.supabaseFrom,
    rpc: mocks.supabaseRpc,
  },
}));

vi.mock('@/e2ee-session/deviceRegistry', () => ({
  listFanoutTargets: mocks.listFanoutTargets,
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'alice-dev-1',
  isDeviceIdTemporary: () => false,
}));

vi.mock('@/lib/crypto/deviceRatchet', () => ({
  ratchetEncrypt: mocks.ratchetEncrypt,
  ratchetDecryptWithSession: vi.fn(),
  establishDeviceSession: vi.fn(),
  getSessionPeerSpkId: vi.fn(async () => null),
  invalidateDeviceSession: vi.fn(),
  RATCHET_PREFIX_V4: 'x3dh4.',
  RATCHET_PREFIX_V5: 'x3dh5.',
}));

vi.mock('@/lib/crypto/x3dh', () => ({
  fetchPrekeyBundleForDevice: vi.fn(),
  isDevicePrekeyBundleError: vi.fn(() => false),
  peekDeviceSignedPrekey: vi.fn(),
  x3dhInitiate: vi.fn(),
  x3dhRespondForDevice: vi.fn(),
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  getOrCreateIdentityKeys: vi.fn(),
  PinUnlockRequiredError: class PinUnlockRequiredError extends Error {},
}));

vi.mock('@/lib/crypto/cryptoIntegrity', () => ({
  hardCrypto: globalThis.crypto,
  hardGlobals: { TextEncoder, TextDecoder },
}));

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: vi.fn(),
  logCryptoException: vi.fn(),
}));

vi.mock('@/lib/crypto/utils', () => ({
  randomBytes: (n: number) => new Uint8Array(n),
  bufferToBase64: (b: ArrayBuffer) => Buffer.from(new Uint8Array(b)).toString('base64'),
  base64ToBuffer: (s: string) => Buffer.from(s, 'base64').buffer,
}));

import { supabase } from '@/integrations/supabase/client';
import { listFanoutTargets } from '@/e2ee-session/deviceRegistry';
import { ratchetEncrypt } from '@/lib/crypto/deviceRatchet';
import { fanoutMessageCopies } from '../multiDeviceFanout';

const ALICE = 'alice-user';
const BOB = 'bob-user';

beforeEach(() => {
  vi.clearAllMocks();
  (ratchetEncrypt as any).mockResolvedValue('x3dh5.session.peerDh.0.0.iv.ct');
});

function installSupabaseTables(insertSink: any[]) {
  (supabase.from as any).mockImplementation((table: string) => {
    if (table === 'conversation_participants') {
      return {
        select: () => ({
          eq: async () => ({
            data: [{ user_id: ALICE }, { user_id: BOB }],
            error: null,
          }),
        }),
      };
    }

    if (table === 'message_device_copies') {
      return {
        upsert: async (rows: any[]) => {
          insertSink.push(...rows);
          return { error: null };
        },
      };
    }

    if (table === 'messages') {
      return {
        update: () => ({
          eq: async () => ({ error: null }),
        }),
      };
    }

    throw new Error(`Unexpected table: ${table}`);
  });
}

describe('multiDeviceFanout trust gate', () => {
  it('fans out only to devices returned by the verified device registry', async () => {
    const inserted: any[] = [];
    installSupabaseTables(inserted);
    (listFanoutTargets as any).mockResolvedValue([
      {
        userId: ALICE,
        deviceId: 'alice-dev-1',
        devicePublicKey: 'SELF',
      },
      {
        userId: BOB,
        deviceId: 'bob-signed-dev',
        devicePublicKey: 'BOB_SIGNED',
      },
    ]);
    (supabase.rpc as any).mockResolvedValue({
      data: [
        { device_id: 'bob-rogue-dev', device_public_key: 'ROGUE' },
      ],
      error: null,
    });

    const result = await fanoutMessageCopies({
      messageId: 'msg-1',
      conversationId: 'conv-1',
      senderUserId: ALICE,
      plaintext: 'hello',
    });

    expect(result).toEqual({ inserted: 1, multiDevice: true });
    expect(listFanoutTargets).toHaveBeenCalledWith(ALICE, [ALICE, BOB]);
    expect(supabase.rpc).not.toHaveBeenCalledWith('list_active_devices_for_user', expect.anything());
    expect(inserted).toHaveLength(1);
    expect(inserted[0].recipient_device_id).toBe('bob-signed-dev');
    expect(inserted[0].recipient_user_id).toBe(BOB);
  });
});
