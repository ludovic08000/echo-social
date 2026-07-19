/**
 * Cross-platform v5 device copy decryption — non-regression test.
 *
 * Guards the Win↔iOS bug where `tryDecryptCopy` recognized only v3/v4
 * ratchet prefixes and let v5 (`x3dh5.`) envelopes silently fall through
 * every decoder, leaving the message displayed as ciphertext.
 *
 * Sesame-lite routes only authenticated v5 envelopes. Older formats must be
 * rejected without touching ratchet state or requesting refanout.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factories below can reference these handles safely.
const mocks = vi.hoisted(() => ({
  ratchetDecryptWithSession: vi.fn(),
  requestDeviceCopyRetry: vi.fn(),
  supabaseRpc: vi.fn(),
  x3dhRespondForDevice: vi.fn(),
  getOrCreateIdentityKeys: vi.fn(),
  invalidateDeviceSession: vi.fn(),
  senderIdentityKey: { value: null as string | null },
  x3dhUnwrapForDeviceFlag: { called: false },
}));
const {
  ratchetDecryptWithSession,
  requestDeviceCopyRetry,
  supabaseRpc,
  x3dhRespondForDevice,
  getOrCreateIdentityKeys,
  invalidateDeviceSession,
  senderIdentityKey,
  x3dhUnwrapForDeviceFlag,
} = mocks;

vi.mock('@/lib/crypto/deviceRatchet', () => ({
  ratchetEncrypt: vi.fn(),
  ratchetDecryptWithSession: mocks.ratchetDecryptWithSession,
  establishDeviceSession: vi.fn(),
  getSessionPeerSpkId: vi.fn(),
  invalidateDeviceSession: mocks.invalidateDeviceSession,
  RATCHET_PREFIX_V4: 'x3dh4.',
  RATCHET_PREFIX_V5: 'x3dh5.',
}));

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: vi.fn(),
  logCryptoException: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: () => {
          mocks.x3dhUnwrapForDeviceFlag.called = true;
          return Promise.resolve({
            data: mocks.senderIdentityKey.value
              ? { identity_key: mocks.senderIdentityKey.value }
              : null,
          });
        } }) }),
      }),
    }),
    rpc: mocks.supabaseRpc,
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-recipient' } } }) },
  },
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'device-ios',
  isDeviceIdTemporary: () => false,
}));

vi.mock('@/lib/messaging/deviceCopyRetryRequest', () => ({
  requestDeviceCopyRetry: mocks.requestDeviceCopyRetry,
}));

vi.mock('@/lib/crypto/x3dh', () => ({
  fetchPrekeyBundleForDevice: vi.fn(),
  peekDeviceSignedPrekey: vi.fn(),
  x3dhInitiate: vi.fn(),
  x3dhRespond: vi.fn(),
  x3dhRespondForDevice: mocks.x3dhRespondForDevice,
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  getOrCreateIdentityKeys: mocks.getOrCreateIdentityKeys,
  PinUnlockRequiredError: class PinUnlockRequiredError extends Error {},
}));

vi.mock('@/lib/crypto/cryptoIntegrity', () => ({
  hardCrypto: globalThis.crypto,
  hardGlobals: { TextEncoder, TextDecoder },
}));

vi.mock('@/lib/crypto/utils', () => ({
  randomBytes: (n: number) => new Uint8Array(n),
  bufferToBase64: (b: ArrayBuffer) => Buffer.from(new Uint8Array(b)).toString('base64'),
  base64ToBuffer: (s: string) => Buffer.from(s, 'base64').buffer,
}));

import { tryDecryptDeviceTargetedBody, tryReadDeviceCopy } from '@/lib/messaging/multiDeviceFanout';

const SENDER = { user_id: 'user-windows', device_id: 'device-windows' };
const ME = { userId: 'user-recipient', deviceId: 'device-ios' };

beforeEach(() => {
  ratchetDecryptWithSession.mockReset();
  requestDeviceCopyRetry.mockReset();
  requestDeviceCopyRetry.mockResolvedValue(true);
  supabaseRpc.mockReset();
  supabaseRpc.mockResolvedValue({ data: [] });
  x3dhRespondForDevice.mockReset();
  getOrCreateIdentityKeys.mockReset();
  invalidateDeviceSession.mockReset();
  getOrCreateIdentityKeys.mockResolvedValue({});
  senderIdentityKey.value = null;
  x3dhUnwrapForDeviceFlag.called = false;
});

describe('tryDecryptCopy — cross-platform v5 envelope routing', () => {
  it('routes v5 (`x3dh5.`) device copies to ratchetDecryptWithSession', async () => {
    ratchetDecryptWithSession.mockResolvedValue('hello from windows');

    const pt = await tryDecryptDeviceTargetedBody(
      {
        encrypted_body: 'x3dh5.session-abc.peerDh.0.0.aaaa.bbbb',
        sender_user_id: SENDER.user_id,
        sender_device_id: SENDER.device_id,
      },
      ME.userId,
      ME.deviceId,
    );

    expect(pt).toBe('hello from windows');
    expect(ratchetDecryptWithSession).toHaveBeenCalledTimes(1);
    expect(ratchetDecryptWithSession).toHaveBeenCalledWith(
      ME.userId,
      ME.deviceId,
      SENDER.user_id,
      SENDER.device_id,
      expect.stringMatching(/^x3dh5\./),
    );
    // Must NOT misroute v5 to the X3DH unwrap path (which would query user_public_keys).
    expect(x3dhUnwrapForDeviceFlag.called).toBe(false);
  });

  it('rejects former v4 (`x3dh4.`) copies', async () => {
    ratchetDecryptWithSession.mockResolvedValue('hello v4');

    const pt = await tryDecryptDeviceTargetedBody(
      {
        encrypted_body: 'x3dh4.session-xyz.peerDh.0.0.aaaa.bbbb',
        sender_user_id: SENDER.user_id,
        sender_device_id: SENDER.device_id,
      },
      ME.userId,
      ME.deviceId,
    );

    expect(pt).toBeNull();
    expect(ratchetDecryptWithSession).not.toHaveBeenCalled();
  });

  it('does not route disabled v3 (`x3dh3.`) copies through the v5/v4 path', async () => {
    ratchetDecryptWithSession.mockResolvedValue('hello v3');

    const pt = await tryDecryptDeviceTargetedBody(
      {
        encrypted_body: 'x3dh3.session-old.0.aaaa.bbbb',
        sender_user_id: SENDER.user_id,
        sender_device_id: SENDER.device_id,
      },
      ME.userId,
      ME.deviceId,
    );

    expect(pt).toBeNull();
    expect(ratchetDecryptWithSession).not.toHaveBeenCalled();
  });

  it('returns null (no misroute) when ratchet decrypt fails on v5 copy', async () => {
    ratchetDecryptWithSession.mockResolvedValue(null);

    const pt = await tryDecryptDeviceTargetedBody(
      {
        encrypted_body: 'x3dh5.session-abc.peerDh.0.0.aaaa.bbbb',
        sender_user_id: SENDER.user_id,
        sender_device_id: SENDER.device_id,
      },
      ME.userId,
      ME.deviceId,
    );

    expect(pt).toBeNull();
    expect(ratchetDecryptWithSession).toHaveBeenCalledTimes(1);
    expect(invalidateDeviceSession).not.toHaveBeenCalled();
    // Still must not fall through to X3DH unwrap (would consume an OPK for nothing).
    expect(x3dhUnwrapForDeviceFlag.called).toBe(false);
  });

  it('does not start a refanout protocol when a v5 copy fails', async () => {
    ratchetDecryptWithSession.mockResolvedValue(null);
    supabaseRpc.mockImplementation((name: string) => {
      if (name === 'get_device_copy_for_message') {
        return Promise.resolve({
          data: [{
            encrypted_body: 'x3dh5.session-abc.peerDh.0.0.aaaa.bbbb',
            sender_user_id: SENDER.user_id,
            sender_device_id: SENDER.device_id,
            recipient_device_id: ME.deviceId,
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    const pt = await tryReadDeviceCopy('message-v5-failed', SENDER.user_id);

    expect(pt).toBeNull();
    expect(ratchetDecryptWithSession).toHaveBeenCalledTimes(1);
    expect(requestDeviceCopyRetry).not.toHaveBeenCalled();
  });

  it('does not request retry during diagnostic resync scans', async () => {
    ratchetDecryptWithSession.mockResolvedValue(null);
    supabaseRpc.mockImplementation((name: string) => {
      if (name === 'get_device_copy_for_message') {
        return Promise.resolve({
          data: [{
            encrypted_body: 'x3dh5.session-abc.peerDh.0.0.aaaa.bbbb',
            sender_user_id: SENDER.user_id,
            sender_device_id: SENDER.device_id,
            recipient_device_id: ME.deviceId,
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    const pt = await tryReadDeviceCopy('message-resync-scan', SENDER.user_id, { requestRetry: false });

    expect(pt).toBeNull();
    expect(ratchetDecryptWithSession).toHaveBeenCalledTimes(1);
    expect(requestDeviceCopyRetry).not.toHaveBeenCalled();
  });

  it('does not try to decrypt another device copy when the current device has no targeted row', async () => {
    ratchetDecryptWithSession.mockResolvedValue('should-not-be-used');
    supabaseRpc.mockImplementation((name: string) => {
      if (name === 'get_device_copy_for_message') {
        return Promise.resolve({ data: [] });
      }
      if (name === 'get_device_copies_for_user') {
        return Promise.resolve({
          data: [{
            encrypted_body: 'x3dh5.session-abc.peerDh.0.0.aaaa.bbbb',
            sender_user_id: SENDER.user_id,
            sender_device_id: SENDER.device_id,
            recipient_device_id: 'some-other-device',
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    const pt = await tryReadDeviceCopy('message-needs-refanout', SENDER.user_id);

    expect(pt).toBeNull();
    expect(ratchetDecryptWithSession).not.toHaveBeenCalled();
    expect(requestDeviceCopyRetry).not.toHaveBeenCalled();
  });

  it('does not request refanout for missing targeted rows during diagnostic scans', async () => {
    supabaseRpc.mockImplementation((name: string) => {
      if (name === 'get_device_copy_for_message') {
        return Promise.resolve({ data: [] });
      }
      if (name === 'get_device_copies_for_user') {
        return Promise.resolve({
          data: [{
            encrypted_body: 'x3dh5.session-abc.peerDh.0.0.aaaa.bbbb',
            sender_user_id: SENDER.user_id,
            sender_device_id: SENDER.device_id,
            recipient_device_id: 'some-other-device',
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    const pt = await tryReadDeviceCopy('message-diagnostic-missing-target', SENDER.user_id, { requestRetry: false });

    expect(pt).toBeNull();
    expect(ratchetDecryptWithSession).not.toHaveBeenCalled();
    expect(requestDeviceCopyRetry).not.toHaveBeenCalled();
  });

  it('rejects the former unversioned x3dh5.init bootstrap', async () => {
    senderIdentityKey.value = 'sender-identity-key-b64';
    x3dhRespondForDevice.mockRejectedValue(new Error('X3DH_OPK_PRIVATE_MISSING'));
    supabaseRpc.mockImplementation((name: string) => {
      if (name === 'get_device_copy_for_message') {
        return Promise.resolve({
          data: [{
            encrypted_body: 'x3dh5.init.AAAA.AAAA.AAAA.1.7',
            sender_user_id: SENDER.user_id,
            sender_device_id: SENDER.device_id,
            recipient_device_id: ME.deviceId,
          }],
        });
      }
      return Promise.resolve({ data: [] });
    });

    const pt = await tryReadDeviceCopy('message-opk-missing', SENDER.user_id);

    expect(pt).toBeNull();
    expect(x3dhRespondForDevice).not.toHaveBeenCalled();
    expect(requestDeviceCopyRetry).not.toHaveBeenCalled();
  });
});
