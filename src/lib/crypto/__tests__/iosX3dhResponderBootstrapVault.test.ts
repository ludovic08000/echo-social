import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  runTxOn,
  readDeviceVaultRecord,
  establishDeviceSession,
  isIosWebRuntime,
} = vi.hoisted(() => ({
  runTxOn: vi.fn(),
  readDeviceVaultRecord: vi.fn(),
  establishDeviceSession: vi.fn(),
  isIosWebRuntime: vi.fn(),
}));

vi.mock('../indexedDbTx', () => ({
  runTxOn,
  reqToPromise: vi.fn(),
}));

vi.mock('../deviceVault', () => ({
  readDeviceVaultRecord,
}));

vi.mock('@/platforms/ios/iosRuntime', () => ({
  isIosWebRuntime,
}));

vi.mock('../deviceRatchet', () => ({
  establishDeviceSession,
}));

import { establishResponderRatchetFromDeviceX3DH } from '../x3dhRatchetBootstrap';

describe('iOS X3DH responder bootstrap from ACE DeviceVault', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTxOn.mockResolvedValue(undefined);
    isIosWebRuntime.mockReturnValue(true);
    establishDeviceSession.mockResolvedValue('s_bootstrap');
  });

  it('loads the exact SPK from ACE when the plaintext IndexedDB mirror is absent', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const deviceId = 'dev_1509c8a4951c4c429bf6d11ba39e3d6e';
    const peerUserId = '00000000-0000-4000-8000-000000000002';
    const peerDeviceId = 'dev_19bf00a37740499698c84fc8e2142783';
    const spkId = 279747818;
    const id = `${userId}::dev::${deviceId}::${spkId}`;
    const privateKeyJWK: JsonWebKey = {
      kty: 'OKP',
      crv: 'X25519',
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      d: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    };
    const sealed = {
      id,
      spkId,
      privateKeyJWK,
      publicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      createdAt: Date.now(),
    };

    readDeviceVaultRecord.mockImplementation(async (_storageId, validate) =>
      validate(sealed) ? sealed : null,
    );

    const sharedSecret = new Uint8Array(32).fill(7).buffer;
    const result = await establishResponderRatchetFromDeviceX3DH({
      myUserId: userId,
      myDeviceId: deviceId,
      peerUserId,
      peerDeviceId,
      sharedSecret,
      sessionId: 's_bootstrap',
      spkId,
      selfIkPubB64: 'self-ik',
      peerIkPubB64: 'peer-ik',
    });

    expect(result).toBe('s_bootstrap');
    expect(readDeviceVaultRecord).toHaveBeenCalledTimes(1);
    expect(readDeviceVaultRecord.mock.calls[0][0]).toBe(`x3dh-prekey::${id}`);
    expect(establishDeviceSession).toHaveBeenCalledWith(
      userId,
      deviceId,
      peerUserId,
      peerDeviceId,
      sharedSecret,
      's_bootstrap',
      expect.objectContaining({
        isInitiator: false,
        peerSpkId: spkId,
        selfInitialDhPrivJwk: privateKeyJWK,
        selfInitialDhPubB64: sealed.publicKeyBase64,
        selfIkPubB64: 'self-ik',
        peerIkPubB64: 'peer-ik',
      }),
    );
  });

  it('does not use the ACE fallback on Windows/desktop Web', async () => {
    isIosWebRuntime.mockReturnValue(false);

    await expect(establishResponderRatchetFromDeviceX3DH({
      myUserId: '00000000-0000-4000-8000-000000000001',
      myDeviceId: 'dev_windows000000000000000000000000',
      peerUserId: '00000000-0000-4000-8000-000000000002',
      peerDeviceId: 'dev_peer000000000000000000000000000',
      sharedSecret: new Uint8Array(32).buffer,
      sessionId: 's_bootstrap',
      spkId: 123,
      selfIkPubB64: 'self-ik',
      peerIkPubB64: 'peer-ik',
    })).rejects.toThrow('X3DH_RESPONDER_SPK_BOOTSTRAP_MISSING');

    expect(readDeviceVaultRecord).not.toHaveBeenCalled();
    expect(establishDeviceSession).not.toHaveBeenCalled();
  });
});
