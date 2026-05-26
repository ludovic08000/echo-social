import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ratchetEncrypt: vi.fn(),
  establishDeviceSession: vi.fn(),
  invalidateDeviceSession: vi.fn(),
  listKnownSessionIds: vi.fn(),
  fetchPrekeyBundleForDevice: vi.fn(),
  invalidateDeviceBundleCache: vi.fn(),
  x3dhInitiate: vi.fn(),
  getOrCreateIdentityKeys: vi.fn(),
  logCryptoError: vi.fn(),
  describeSession: vi.fn(),
  markSessionUsed: vi.fn(),
  isDeviceStale: vi.fn(),
  resolveActiveDeviceDescriptor: vi.fn(),
}));

vi.mock('@/lib/crypto/deviceRatchet', () => ({
  ratchetEncrypt: mocks.ratchetEncrypt,
  establishDeviceSession: mocks.establishDeviceSession,
  invalidateDeviceSession: mocks.invalidateDeviceSession,
  listKnownSessionIds: mocks.listKnownSessionIds,
  RATCHET_PREFIX_V4: 'x3dh4.',
  RATCHET_PREFIX_V5: 'x3dh5.',
}));

vi.mock('@/lib/crypto/x3dh', () => ({
  fetchPrekeyBundleForDevice: mocks.fetchPrekeyBundleForDevice,
  invalidateDeviceBundleCache: mocks.invalidateDeviceBundleCache,
  x3dhInitiate: mocks.x3dhInitiate,
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  getOrCreateIdentityKeys: mocks.getOrCreateIdentityKeys,
}));

vi.mock('@/lib/crypto/errorLogger', () => ({
  logCryptoError: mocks.logCryptoError,
}));

vi.mock('../sessionStore', () => ({
  describeSession: mocks.describeSession,
  markSessionUsed: mocks.markSessionUsed,
}));

vi.mock('../deviceRegistry', () => ({
  selfDeviceId: () => 'self-device',
  isDeviceStale: mocks.isDeviceStale,
  resolveActiveDeviceDescriptor: mocks.resolveActiveDeviceDescriptor,
}));

import { encryptForDevice, ensureSession } from '../sessionManager';

const PEER = {
  userId: 'peer-user',
  deviceId: 'peer-device',
  devicePublicKey: 'peer-pub',
  lastSeen: Date.now(),
};

const DESC = {
  sessionId: 'session-desc',
  selfUserId: 'me',
  selfDeviceId: 'self-device',
  peerUserId: PEER.userId,
  peerDeviceId: PEER.deviceId,
  status: 'inactive' as const,
  layer: 'x3dh-bootstrap' as const,
  createdAt: 1,
  lastUsedAt: 0,
};

function activeBundle() {
  return {
    identityKey: 'identity',
    signingKey: 'signing',
    signedPrekey: 'spk',
    signedPrekeySignature: 'sig',
    signedPrekeyId: 7,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.describeSession.mockReturnValue(DESC);
  mocks.listKnownSessionIds.mockResolvedValue([]);
  mocks.isDeviceStale.mockReturnValue(false);
  mocks.resolveActiveDeviceDescriptor.mockResolvedValue(PEER);
  mocks.getOrCreateIdentityKeys.mockResolvedValue({ privateKey: {}, publicKey: {}, signingPrivateKey: {}, signingPublicKey: {} });
  mocks.fetchPrekeyBundleForDevice.mockResolvedValue(activeBundle());
  mocks.x3dhInitiate.mockResolvedValue({ sharedSecret: new Uint8Array(32).buffer });
});

describe('sessionManager v5 and device hygiene', () => {
  it('accepts x3dh4 cached ratchet envelopes', async () => {
    const ct = 'x3dh4.sess.dh.0.0.iv.ct';
    mocks.ratchetEncrypt.mockResolvedValue(ct);

    await expect(encryptForDevice('me', PEER, 'hello')).resolves.toBe(ct);

    expect(mocks.markSessionUsed).toHaveBeenCalledWith('session-desc', 'ratchet-v4');
    expect(mocks.getOrCreateIdentityKeys).not.toHaveBeenCalled();
  });

  it('accepts x3dh5 cached ratchet envelopes', async () => {
    const ct = 'x3dh5.sess.dh.0.0.iv.ct';
    mocks.ratchetEncrypt.mockResolvedValue(ct);

    await expect(encryptForDevice('me', PEER, 'hello')).resolves.toBe(ct);

    expect(mocks.markSessionUsed).toHaveBeenCalledWith('session-desc', 'ratchet-v5');
    expect(mocks.invalidateDeviceBundleCache).not.toHaveBeenCalled();
  });

  it('does not null a valid v5 ciphertext', async () => {
    mocks.ratchetEncrypt.mockResolvedValue('x3dh5.sess.dh.1.0.iv.ct');

    const encrypted = await encryptForDevice('me', PEER, 'hello');

    expect(encrypted).toMatch(/^x3dh5\./);
    expect(mocks.fetchPrekeyBundleForDevice).not.toHaveBeenCalled();
  });

  it('skips stale devices before X3DH', async () => {
    mocks.resolveActiveDeviceDescriptor.mockResolvedValue(null);

    const desc = await ensureSession('me', PEER, {} as any);

    expect(desc).toBe(DESC);
    expect(mocks.fetchPrekeyBundleForDevice).not.toHaveBeenCalled();
    expect(mocks.logCryptoError).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'E_SKIP_STALE_DEVICE',
    }));
  });

  it('skips revoked devices before X3DH', async () => {
    mocks.resolveActiveDeviceDescriptor.mockResolvedValue({ ...PEER, revokedAt: Date.now() });
    mocks.isDeviceStale.mockReturnValue(true);

    await ensureSession('me', PEER, {} as any);

    expect(mocks.fetchPrekeyBundleForDevice).not.toHaveBeenCalled();
    expect(mocks.logCryptoError).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'E_SKIP_STALE_DEVICE',
    }));
  });

  it('retries encrypt only once after E_NO_SESSION', async () => {
    mocks.ratchetEncrypt
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(encryptForDevice('me', PEER, 'hello')).resolves.toBeNull();

    expect(mocks.invalidateDeviceBundleCache).toHaveBeenCalledTimes(1);
    expect(mocks.fetchPrekeyBundleForDevice).toHaveBeenCalledTimes(1);
    expect(mocks.establishDeviceSession).toHaveBeenCalledTimes(1);
    expect(mocks.ratchetEncrypt).toHaveBeenCalledTimes(2);
  });
});
