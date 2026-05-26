import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ratchetEncrypt: vi.fn(),
  getSessionPeerSpkId: vi.fn(),
  invalidateDeviceSession: vi.fn(),
  fetchPrekeyBundleForDevice: vi.fn(),
  invalidateDeviceBundleCache: vi.fn(),
  peekDeviceSignedPrekey: vi.fn(),
  x3dhInitiate: vi.fn(),
  x3dhRespondForDevice: vi.fn(),
  getOrCreateIdentityKeys: vi.fn(),
  logCryptoError: vi.fn(),
  logCryptoException: vi.fn(),
  ratchetDecryptWithSession: vi.fn(),
  getDeviceCryptoInvalid: vi.fn(),
  requestDevicePrekeyRepair: vi.fn(),
  requestDeviceCopyRetry: vi.fn(),
  requestMessageRefanout: vi.fn(),
  listDevicesForUser: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'sender' } } })) },
  },
}));

vi.mock('../currentDevice', () => ({
  getCurrentDeviceId: () => 'sender-device',
  isDeviceIdTemporary: () => false,
}));

vi.mock('../deviceWrap', () => ({
  unwrapPlaintextForDevice: vi.fn(),
  wrapPlaintextForDevice: vi.fn(),
}));

vi.mock('../deviceCopyRetryRequest', () => ({
  requestDeviceCopyRetry: mocks.requestDeviceCopyRetry,
  requestMessageRefanout: mocks.requestMessageRefanout,
}));

vi.mock('../deviceCryptoInvalid', () => ({
  getDeviceCryptoInvalid: mocks.getDeviceCryptoInvalid,
  requestDevicePrekeyRepair: mocks.requestDevicePrekeyRepair,
}));

vi.mock('@/e2ee-session/deviceRegistry', () => ({
  listDevicesForUser: mocks.listDevicesForUser,
}));

vi.mock('@/lib/crypto/x3dh', () => ({
  fetchPrekeyBundleForDevice: mocks.fetchPrekeyBundleForDevice,
  invalidateDeviceBundleCache: mocks.invalidateDeviceBundleCache,
  peekDeviceSignedPrekey: mocks.peekDeviceSignedPrekey,
  x3dhInitiate: mocks.x3dhInitiate,
  x3dhRespond: vi.fn(),
  x3dhRespondForDevice: mocks.x3dhRespondForDevice,
  X3DH_OPK_PRIVATE_MISSING: 'X3DH_OPK_PRIVATE_MISSING',
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  getOrCreateIdentityKeys: mocks.getOrCreateIdentityKeys,
}));

vi.mock('@/lib/crypto/deviceRatchet', () => ({
  ratchetEncrypt: mocks.ratchetEncrypt,
  ratchetDecryptWithSession: mocks.ratchetDecryptWithSession,
  establishDeviceSession: vi.fn(),
  getSessionPeerSpkId: mocks.getSessionPeerSpkId,
  invalidateDeviceSession: mocks.invalidateDeviceSession,
  RATCHET_PREFIX_V3: 'x3dh3.',
  RATCHET_PREFIX_V4: 'x3dh4.',
  RATCHET_PREFIX_V5: 'x3dh5.',
  isModernRatchetPayload: (payload: string) => payload.startsWith('x3dh4.') || payload.startsWith('x3dh5.'),
}));

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: mocks.logCryptoError,
  logCryptoException: mocks.logCryptoException,
}));

import { encryptPlaintextForDeviceTarget, fanoutMessageCopies, tryReadDeviceCopy } from '../multiDeviceFanout';

function makeMaybeSingleBuilder(data: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
  };
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionPeerSpkId.mockResolvedValue(null);
  mocks.peekDeviceSignedPrekey.mockResolvedValue(null);
  mocks.getDeviceCryptoInvalid.mockReturnValue(null);
  mocks.requestDevicePrekeyRepair.mockResolvedValue(true);
  mocks.requestDeviceCopyRetry.mockResolvedValue(true);
  mocks.requestMessageRefanout.mockResolvedValue(true);
  mocks.ratchetDecryptWithSession.mockResolvedValue(null);
  mocks.getOrCreateIdentityKeys.mockResolvedValue({ privateKey: {} });
  mocks.listDevicesForUser.mockReset();
});

describe('multiDeviceFanout v5 retry safety', () => {
  it('accepts x3dh5 ratchet output without forcing a new X3DH', async () => {
    mocks.ratchetEncrypt.mockResolvedValue('x3dh5.sess.dh.0.0.iv.ct');

    const result = await encryptPlaintextForDeviceTarget({
      senderUserId: 'sender',
      recipientUserId: 'recipient',
      recipientDeviceId: 'recipient-device',
      recipientDevicePublicKey: 'recipient-pub',
      plaintext: 'hello',
    });

    expect(result?.encryptedBody).toMatch(/^x3dh5\./);
    expect(mocks.fetchPrekeyBundleForDevice).not.toHaveBeenCalled();
  });

  it('bounds X3DH recovery to the first attempt plus one refetch retry', async () => {
    mocks.ratchetEncrypt.mockResolvedValue(null);
    mocks.fetchPrekeyBundleForDevice
      .mockRejectedValueOnce(new Error('stale bundle'))
      .mockRejectedValueOnce(new Error('still stale'));

    const result = await encryptPlaintextForDeviceTarget({
      senderUserId: 'sender',
      recipientUserId: 'recipient',
      recipientDeviceId: 'recipient-device',
      recipientDevicePublicKey: 'recipient-pub',
      plaintext: 'hello',
    });

    expect(result).toBeNull();
    expect(mocks.fetchPrekeyBundleForDevice).toHaveBeenCalledTimes(2);
    expect(mocks.invalidateDeviceBundleCache).toHaveBeenCalledTimes(1);
  });

  it('skips a locally crypto-invalid device before ratchet, X3DH, or legacy fallback', async () => {
    mocks.getDeviceCryptoInvalid.mockReturnValue({
      userId: 'recipient',
      deviceId: 'recipient-device',
      reason: 'known_invalid_device_quarantine',
      markedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    });

    const result = await encryptPlaintextForDeviceTarget({
      senderUserId: 'sender',
      recipientUserId: 'recipient',
      recipientDeviceId: 'recipient-device',
      recipientDevicePublicKey: 'recipient-pub',
      plaintext: 'hello',
    });

    expect(result).toBeNull();
    expect(mocks.ratchetEncrypt).not.toHaveBeenCalled();
    expect(mocks.fetchPrekeyBundleForDevice).not.toHaveBeenCalled();
    expect(mocks.requestDevicePrekeyRepair).toHaveBeenCalledWith(
      'recipient',
      'recipient-device',
      'known_invalid_device_quarantine',
    );
  });

  it('does not retry or downgrade when X3DH marks the device crypto-invalid', async () => {
    mocks.ratchetEncrypt.mockResolvedValue(null);
    mocks.getDeviceCryptoInvalid
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        userId: 'recipient',
        deviceId: 'recipient-device',
        reason: 'invalid_spk_signature_fetch',
        markedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      });
    mocks.fetchPrekeyBundleForDevice.mockRejectedValue(new Error('invalid SPK signature'));

    const result = await encryptPlaintextForDeviceTarget({
      senderUserId: 'sender',
      recipientUserId: 'recipient',
      recipientDeviceId: 'recipient-device',
      recipientDevicePublicKey: 'recipient-pub',
      plaintext: 'hello',
    });

    expect(result).toBeNull();
    expect(mocks.fetchPrekeyBundleForDevice).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateDeviceBundleCache).not.toHaveBeenCalled();
    expect(mocks.requestDevicePrekeyRepair).toHaveBeenCalledWith(
      'recipient',
      'recipient-device',
      'invalid_spk_signature_fetch',
    );
  });

  it('requests a fresh device copy when an announced OPK private key is missing', async () => {
    const { supabase } = await import('@/integrations/supabase/client');
    vi.mocked(supabase.rpc).mockImplementation(async (name: string) => {
      if (name === 'get_device_copy_for_message') {
        return {
          data: [{
            encrypted_body: 'x3dh2.iv.ct.ek.7.42',
            sender_user_id: 'sender-1',
            sender_device_id: 'sender-device-1',
            recipient_device_id: 'recipient-device-1',
          }],
          error: null,
        } as any;
      }
      return { data: null, error: null } as any;
    });
    vi.mocked(supabase.from).mockReturnValue(makeMaybeSingleBuilder({ identity_key: 'sender-identity' }) as any);
    mocks.x3dhRespondForDevice.mockRejectedValue(new Error('X3DH_OPK_PRIVATE_MISSING'));

    await expect(tryReadDeviceCopy('message-1', 'sender-1')).resolves.toBeNull();

    expect(mocks.requestDeviceCopyRetry).toHaveBeenCalledWith({
      messageId: 'message-1',
      senderUserId: 'sender-1',
    });
    expect(mocks.requestMessageRefanout).not.toHaveBeenCalled();
  });

  it('fan-out inserts copies only for valid active devices', async () => {
    const { supabase } = await import('@/integrations/supabase/client');
    const upsertedRows: Array<Record<string, string>> = [];
    function makeTableBuilder(table: string) {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        update: vi.fn(() => builder),
        upsert: vi.fn(async (rows: Array<Record<string, string>>) => {
          upsertedRows.push(...rows);
          return { error: null };
        }),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
          if (table === 'conversation_participants') {
            return Promise.resolve({
              data: [{ user_id: 'sender' }, { user_id: 'recipient' }],
              error: null,
            }).then(resolve, reject);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        },
      };
      return builder;
    }
    vi.mocked(supabase.from).mockImplementation((table: string) => makeTableBuilder(table) as any);
    mocks.listDevicesForUser.mockImplementation(async (userId: string) => (
      userId === 'sender'
        ? [{ userId: 'sender', deviceId: 'sender-device', devicePublicKey: 'sender-pub', lastSeen: Date.now() }]
        : [
          { userId: 'recipient', deviceId: 'recipient-good', devicePublicKey: 'good-pub', lastSeen: Date.now() },
          { userId: 'recipient', deviceId: 'recipient-bad', devicePublicKey: 'bad-pub', lastSeen: Date.now() },
        ]
    ));
    mocks.getDeviceCryptoInvalid.mockImplementation((_userId: string, deviceId: string) => (
      deviceId === 'recipient-bad'
        ? {
          userId: 'recipient',
          deviceId,
          reason: 'invalid_spk_signature',
          markedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }
        : null
    ));
    mocks.ratchetEncrypt.mockImplementation(async (
      _senderUserId: string,
      _senderDeviceId: string,
      _recipientUserId: string,
      recipientDeviceId: string,
    ) => `x3dh5.${recipientDeviceId}.dh.0.0.iv.ct`);

    const result = await fanoutMessageCopies({
      messageId: 'message-1',
      conversationId: 'conversation-1',
      senderUserId: 'sender',
      plaintext: 'hello',
    });

    expect(result.inserted).toBe(2);
    expect(result.failed).toBe(1);
    expect(upsertedRows.map(row => row.recipient_device_id)).toEqual([
      'sender-device',
      'recipient-good',
    ]);
    expect(upsertedRows.map(row => row.recipient_device_id)).not.toContain('recipient-bad');
  });
});
