import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ratchetDecryptWithSession: vi.fn(),
  requestDeviceCopyRetry: vi.fn(),
  supabaseRpc: vi.fn(),
  invalidateDeviceSession: vi.fn(),
}));

vi.mock('@/lib/crypto/deviceRatchet', () => ({
  ratchetEncrypt: vi.fn(),
  ratchetDecryptWithSession: mocks.ratchetDecryptWithSession,
  establishDeviceSession: vi.fn(),
  getSessionPeerSpkId: vi.fn(),
  invalidateDeviceSession: mocks.invalidateDeviceSession,
  AEGIS_RATCHET_PREFIX: 'aegis1.ratchet.',
}));

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: vi.fn(),
  logCryptoException: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
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
  x3dhRespondForDevice: vi.fn(),
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  getOrCreateIdentityKeys: vi.fn().mockResolvedValue({}),
  PinUnlockRequiredError: class PinUnlockRequiredError extends Error {},
}));

vi.mock('@/lib/crypto/cryptoIntegrity', () => ({
  hardCrypto: globalThis.crypto,
  hardGlobals: { TextEncoder, TextDecoder },
}));

vi.mock('@/lib/crypto/utils', () => ({
  randomBytes: (length: number) => new Uint8Array(length),
  bufferToBase64: (buffer: ArrayBuffer) => Buffer.from(new Uint8Array(buffer)).toString('base64'),
  base64ToBuffer: (value: string) => Buffer.from(value, 'base64').buffer,
}));

import {
  clearDeviceCopyCache,
  tryDecryptDeviceTargetedBody,
  tryReadDeviceCopy,
} from '@/lib/messaging/multiDeviceFanout';

const SENDER = { user_id: 'user-windows', device_id: 'device-windows' };
const ME = { userId: 'user-recipient', deviceId: 'device-ios' };
const CAPSULE = 'aegis1.ratchet.session-abc.peerDh.0.0.aaaa.bbbb';

beforeEach(() => {
  vi.clearAllMocks();
  clearDeviceCopyCache();
  mocks.requestDeviceCopyRetry.mockResolvedValue(true);
  mocks.supabaseRpc.mockResolvedValue({ data: [] });
});

describe('Aegis cross-platform device-copy routing', () => {
  it('routes an Aegis ratchet capsule to the device session exactly once', async () => {
    mocks.ratchetDecryptWithSession.mockResolvedValue('content-key-capsule');

    const plaintext = await tryDecryptDeviceTargetedBody(
      {
        encrypted_body: CAPSULE,
        sender_user_id: SENDER.user_id,
        sender_device_id: SENDER.device_id,
      },
      ME.userId,
      ME.deviceId,
    );

    expect(plaintext).toBe('content-key-capsule');
    expect(mocks.ratchetDecryptWithSession).toHaveBeenCalledWith(
      ME.userId,
      ME.deviceId,
      SENDER.user_id,
      SENDER.device_id,
      CAPSULE,
    );
  });

  it('rejects every unknown device-copy wire before touching ratchet state', async () => {
    const plaintext = await tryDecryptDeviceTargetedBody(
      {
        encrypted_body: 'unknown.device.copy',
        sender_user_id: SENDER.user_id,
        sender_device_id: SENDER.device_id,
      },
      ME.userId,
      ME.deviceId,
    );

    expect(plaintext).toBeNull();
    expect(mocks.ratchetDecryptWithSession).not.toHaveBeenCalled();
  });

  it('keeps a failed capsule retryable without invalidating the session', async () => {
    mocks.ratchetDecryptWithSession.mockResolvedValue(null);
    mocks.supabaseRpc.mockImplementation((name: string) => Promise.resolve({
      data: name === 'get_device_copy_for_message'
        ? [{
          encrypted_body: CAPSULE,
          sender_user_id: SENDER.user_id,
          sender_device_id: SENDER.device_id,
          recipient_device_id: ME.deviceId,
        }]
        : [],
    }));

    await expect(tryReadDeviceCopy('message-aegis-failed', SENDER.user_id))
      .resolves.toBeNull();
    expect(mocks.invalidateDeviceSession).not.toHaveBeenCalled();
    expect(mocks.requestDeviceCopyRetry).not.toHaveBeenCalled();
  });

  it('never decrypts a capsule addressed to another physical device', async () => {
    mocks.ratchetDecryptWithSession.mockResolvedValue('must-not-be-used');
    mocks.supabaseRpc.mockResolvedValue({ data: [] });

    await expect(tryReadDeviceCopy('message-without-my-capsule', SENDER.user_id))
      .resolves.toBeNull();
    expect(mocks.ratchetDecryptWithSession).not.toHaveBeenCalled();
  });

  it('does not make a transient missing capsule permanent', async () => {
    mocks.ratchetDecryptWithSession.mockResolvedValue('content-key-after-retry');
    mocks.supabaseRpc
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{
          encrypted_body: CAPSULE,
          sender_user_id: SENDER.user_id,
          sender_device_id: SENDER.device_id,
          recipient_device_id: ME.deviceId,
        }],
      });

    await expect(tryReadDeviceCopy('message-late-capsule', SENDER.user_id))
      .resolves.toBeNull();
    await expect(tryReadDeviceCopy('message-late-capsule', SENDER.user_id, {
      requestRetry: true,
    })).resolves.toBe('content-key-after-retry');

    expect(mocks.supabaseRpc).toHaveBeenCalledTimes(2);
  });
});
