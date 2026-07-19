import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchPrekeyBundleForDevice: vi.fn(),
  isDevicePrekeyBundleError: vi.fn((value: any, code?: string) => (
    value?.name === 'DevicePrekeyBundleError' && (!code || value.code === code)
  )),
  x3dhInitiate: vi.fn(),
  peekDeviceSignedPrekey: vi.fn(),
  ratchetEncrypt: vi.fn(),
  getSessionPeerSpkId: vi.fn(),
  invalidateDeviceSession: vi.fn(),
  wrapPlaintextForDevice: vi.fn(),
  logCryptoError: vi.fn(),
  logCryptoException: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {},
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'sender-device',
  isDeviceIdTemporary: () => false,
}));

vi.mock('@/lib/messaging/deviceWrap', () => ({
  wrapPlaintextForDevice: mocks.wrapPlaintextForDevice,
  unwrapPlaintextForDevice: vi.fn(),
}));

vi.mock('@/lib/messaging/deviceCopyRetryRequest', () => ({
  requestDeviceCopyRetry: vi.fn(),
}));

vi.mock('@/lib/crypto/x3dh', () => ({
  fetchPrekeyBundleForDevice: mocks.fetchPrekeyBundleForDevice,
  isDevicePrekeyBundleError: mocks.isDevicePrekeyBundleError,
  x3dhInitiate: mocks.x3dhInitiate,
  x3dhRespondForDevice: vi.fn(),
  peekDeviceSignedPrekey: mocks.peekDeviceSignedPrekey,
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  getOrCreateIdentityKeys: vi.fn(),
  PinUnlockRequiredError: class PinUnlockRequiredError extends Error {},
}));

vi.mock('@/lib/crypto/deviceRatchet', () => ({
  ratchetEncrypt: mocks.ratchetEncrypt,
  ratchetDecryptWithSession: vi.fn(),
  establishDeviceSession: vi.fn(),
  getSessionPeerSpkId: mocks.getSessionPeerSpkId,
  invalidateDeviceSession: mocks.invalidateDeviceSession,
  RATCHET_PREFIX_V3: 'x3dh3.',
  RATCHET_PREFIX_V4: 'x3dh4.',
  RATCHET_PREFIX_V5: 'x3dh5.',
}));

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: mocks.logCryptoError,
  logCryptoException: mocks.logCryptoException,
}));

import { encryptPlaintextForDeviceTarget } from '@/lib/messaging/multiDeviceFanout';

const INVALID_CACHE_KEY = 'forsure:invalid-device-spk-cache:v1';

function target(deviceId: string) {
  return {
    conversationId: 'conv-1',
    senderUserId: 'sender-user',
    senderDeviceId: 'sender-device',
    recipientUserId: 'recipient-user',
    recipientDeviceId: deviceId,
    recipientDevicePublicKey: 'recipient-device-public-key',
    plaintext: 'secret hello',
  };
}

describe('multiDeviceFanout security gates', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.ratchetEncrypt.mockResolvedValue(null);
    mocks.getSessionPeerSpkId.mockResolvedValue(null);
    mocks.fetchPrekeyBundleForDevice.mockResolvedValue(null);
  });

  it('does not permanently blacklist a historical DeviceID', async () => {
    const result = await encryptPlaintextForDeviceTarget(target('6508eb47a200893f49720fe84b9290b3'));

    expect(result).toBeNull();
    expect(mocks.ratchetEncrypt).toHaveBeenCalledTimes(1);
    expect(mocks.fetchPrekeyBundleForDevice).toHaveBeenCalledTimes(1);
    expect(mocks.wrapPlaintextForDevice).not.toHaveBeenCalled();
    expect(localStorage.getItem(INVALID_CACHE_KEY)).toBeNull();
  });

  it('quarantines an invalid SPK and does not fall back to deviceWrap', async () => {
    mocks.fetchPrekeyBundleForDevice.mockRejectedValue({
      name: 'DevicePrekeyBundleError',
      code: 'DEVICE_SPK_SIGNATURE_INVALID',
    });

    const result = await encryptPlaintextForDeviceTarget(target('fresh-invalid-spk-device'));
    const quarantinedRetry = await encryptPlaintextForDeviceTarget(target('fresh-invalid-spk-device'));

    expect(result).toBeNull();
    expect(quarantinedRetry).toBeNull();
    expect(mocks.fetchPrekeyBundleForDevice).toHaveBeenCalledTimes(1);
    expect(mocks.wrapPlaintextForDevice).not.toHaveBeenCalled();
    expect(localStorage.getItem(INVALID_CACHE_KEY)).toBeNull();
  });

  it('does not permanently mark a temporarily missing bundle as invalid', async () => {
    mocks.fetchPrekeyBundleForDevice.mockResolvedValue(null);

    const result = await encryptPlaintextForDeviceTarget(target('temporarily-offline-device'));

    expect(result).toBeNull();
    expect(mocks.fetchPrekeyBundleForDevice).toHaveBeenCalledTimes(1);
    expect(mocks.wrapPlaintextForDevice).not.toHaveBeenCalled();
    expect(localStorage.getItem(INVALID_CACHE_KEY) ?? '').not.toContain('temporarily-offline-device');
  });
});
