import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  supabaseRpc: vi.fn(),
  tableRows: [] as Array<Record<string, unknown>>,
  tableError: null as { code?: string; message?: string } | null,
  decryptFromLibsignalDevice: vi.fn(),
}));

vi.mock('@/lib/crypto/libsignalRuntime', () => ({
  decodeLibsignalWire: (value: string) => value === 'aegis.libsignal.3.Y2lwaGVy' ? { messageType: 3, ciphertext: new Uint8Array() } : null,
  decryptFromLibsignalDevice: mocks.decryptFromLibsignalDevice,
  encryptForLibsignalDevice: vi.fn(),
}));



vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: vi.fn(),
  logCryptoException: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (
          resolve: (value: {
            data: Array<Record<string, unknown>>;
            error: { code?: string; message?: string } | null;
          }) => unknown,
        ) => Promise.resolve({
          data: mocks.tableRows,
          error: mocks.tableError,
        }).then(resolve),
      };
      return builder;
    },
    rpc: mocks.supabaseRpc,
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-recipient' } } }) },
  },
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'device-ios',
  isDeviceIdTemporary: () => false,
}));

vi.mock('@/lib/crypto/peerKeyCache', () => ({
  getCachedAuthUserId: () => Promise.resolve('user-recipient'),
}));

vi.mock('@/lib/crypto/canonicalDeviceRegistry', () => ({
  fetchVerifiedDeviceList: vi.fn().mockResolvedValue({ trusted: [] }),
}));

vi.mock('@/lib/crypto/cryptoIntegrity', () => ({
  hardCrypto: globalThis.crypto,
  hardGlobals: {
    TextEncoder,
    TextDecoder,
    idbOpen: indexedDB.open.bind(indexedDB),
  },
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
const CAPSULE = 'aegis.libsignal.3.Y2lwaGVy';

beforeEach(() => {
  vi.clearAllMocks();
  clearDeviceCopyCache();
  mocks.supabaseRpc.mockResolvedValue({ data: [] });
  mocks.tableRows = [];
  mocks.tableError = null;
});

describe('Aegis cross-platform device-copy routing', () => {
  it('routes a Libsignal capsule to the device session exactly once', async () => {
    mocks.decryptFromLibsignalDevice.mockResolvedValue('content-key-capsule');

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
    expect(mocks.decryptFromLibsignalDevice).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: ME.userId, ownerDeviceId: ME.deviceId, remoteUserId: SENDER.user_id, remoteDeviceId: SENDER.device_id, payload: CAPSULE }));
  });

  it('rejects every unknown device-copy wire before touching Libsignal state', async () => {
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
    expect(mocks.decryptFromLibsignalDevice).not.toHaveBeenCalled();
  });

  it('keeps a failed Libsignal capsule retryable', async () => {
    mocks.decryptFromLibsignalDevice.mockResolvedValue(null);
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
  });

  it('never decrypts a capsule addressed to another physical device', async () => {
    mocks.supabaseRpc.mockResolvedValue({ data: [] });

    await expect(tryReadDeviceCopy('message-without-my-capsule', SENDER.user_id))
      .resolves.toBeNull();
    expect(mocks.decryptFromLibsignalDevice).not.toHaveBeenCalled();
  });

  it('does not make a transient missing capsule permanent', async () => {
    mocks.decryptFromLibsignalDevice.mockResolvedValue('content-key-after-retry');
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
