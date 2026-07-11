import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  supabaseFrom: vi.fn(),
  supabaseRpc: vi.fn(),
  listFanoutTargets: vi.fn(),
  ratchetEncrypt: vi.fn(),
  fetchPrekeyBundleForDevice: vi.fn(),
  x3dhInitiate: vi.fn(),
  getOrCreateIdentityKeys: vi.fn(),
  exportPublicKeyRaw: vi.fn(),
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
  fetchPrekeyBundleForDevice: mocks.fetchPrekeyBundleForDevice,
  isDevicePrekeyBundleError: vi.fn(() => false),
  peekDeviceSignedPrekey: vi.fn(),
  x3dhInitiate: mocks.x3dhInitiate,
  x3dhRespondForDevice: vi.fn(),
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  getOrCreateIdentityKeys: mocks.getOrCreateIdentityKeys,
  exportPublicKeyRaw: mocks.exportPublicKeyRaw,
  PinUnlockRequiredError: class PinUnlockRequiredError extends Error {},
}));

vi.mock('@/lib/crypto/cryptoIntegrity', () => ({
  hardCrypto: globalThis.crypto.subtle,
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
  mocks.fetchPrekeyBundleForDevice.mockResolvedValue({
    identityKey: 'recipient-identity',
    signingKey: 'recipient-signing',
    signedPrekey: 'recipient-spk',
    signedPrekeySignature: 'recipient-spk-sig',
    signedPrekeyId: 1,
  });
  mocks.x3dhInitiate.mockResolvedValue({
    sharedSecret: new Uint8Array(32).buffer,
    ephemeralKey: 'ephemeral-key',
    usedSPKId: 1,
    usedOTPKId: undefined,
  });
  mocks.getOrCreateIdentityKeys.mockResolvedValue({ publicKey: {} });
  mocks.exportPublicKeyRaw.mockResolvedValue(new Uint8Array(32).buffer);
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

    expect(result).toEqual({ inserted: 2, multiDevice: true });
    expect(listFanoutTargets).toHaveBeenCalledWith(ALICE, [ALICE, BOB], { verifyPrekeys: false });
    expect(supabase.rpc).not.toHaveBeenCalledWith('list_active_devices_for_user', expect.anything());
    expect(inserted).toHaveLength(2);
    expect(inserted.map(row => row.recipient_device_id).sort()).toEqual(['alice-dev-1', 'bob-signed-dev']);
    expect(inserted.find(row => row.recipient_device_id === 'bob-signed-dev')?.recipient_user_id).toBe(BOB);
    expect(inserted.find(row => row.recipient_device_id === 'alice-dev-1')?.recipient_user_id).toBe(ALICE);
  });

  it('does not let one broken device abort fan-out to the remaining devices', async () => {
    const inserted: any[] = [];
    installSupabaseTables(inserted);
    (listFanoutTargets as any).mockResolvedValue([
      {
        userId: BOB,
        deviceId: 'bob-broken-dev',
        devicePublicKey: 'BOB_BROKEN',
      },
      {
        userId: BOB,
        deviceId: 'bob-good-dev',
        devicePublicKey: 'BOB_GOOD',
      },
    ]);
    (ratchetEncrypt as any).mockImplementation(
      async (_senderUser: string, _senderDevice: string, _recipientUser: string, recipientDevice: string) => {
        if (recipientDevice === 'bob-broken-dev') throw new Error('broken ratchet');
        return 'x3dh5.session.peerDh.0.0.iv.ct';
      },
    );
    mocks.fetchPrekeyBundleForDevice.mockImplementation(async (_userId: string, deviceId: string) => {
      if (deviceId === 'bob-broken-dev') return null;
      return {
        identityKey: 'recipient-identity',
        signingKey: 'recipient-signing',
        signedPrekey: 'recipient-spk',
        signedPrekeySignature: 'recipient-spk-sig',
        signedPrekeyId: 1,
      };
    });

    const result = await fanoutMessageCopies({
      messageId: 'msg-2',
      conversationId: 'conv-1',
      senderUserId: ALICE,
      plaintext: 'hello',
    });

    expect(result).toEqual({ inserted: 1, multiDevice: true });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].recipient_device_id).toBe('bob-good-dev');
  });
});
