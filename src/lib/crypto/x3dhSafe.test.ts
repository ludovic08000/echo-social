import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IdentityKeyPair } from './keyManager';

const mocks = vi.hoisted(() => ({
  coreInitiate: vi.fn(),
  deviceRespond: vi.fn(),
  generateDeviceSignedPrekey: vi.fn(),
  refreshDeviceSignedPrekey: vi.fn(),
  refillDeviceOneTimePrekeys: vi.fn(),
  getCurrentDeviceId: vi.fn(() => 'device-1234567890abcdef'),
  isDeviceIdTemporary: vi.fn(() => false),
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: mocks.getCurrentDeviceId,
  isDeviceIdTemporary: mocks.isDeviceIdTemporary,
}));

vi.mock('./x3dh', () => ({
  x3dhInitiate: mocks.coreInitiate,
  x3dhRespondForDevice: mocks.deviceRespond,
  generateAndUploadDeviceSignedPrekey: mocks.generateDeviceSignedPrekey,
  refreshDeviceSignedPrekeyIfNeeded: mocks.refreshDeviceSignedPrekey,
  refillDeviceOneTimePrekeysIfNeeded: mocks.refillDeviceOneTimePrekeys,
}));

import {
  generateAndUploadSignedPrekey,
  refreshSignedPrekeyIfNeeded,
  x3dhInitiate,
  x3dhRespond,
} from './x3dhSafe';

const keys = {} as IdentityKeyPair;
const responderResult = { sharedSecret: new ArrayBuffer(32), spkKeyPair: {} as CryptoKeyPair };
const initiatorResult = {
  sharedSecret: new ArrayBuffer(32),
  ephemeralKey: 'ephemeral',
  usedOTPKId: 9,
  usedSPKId: 7,
};
const deviceBundle = {
  identityKey: 'ik',
  signingKey: 'signing',
  signedPrekey: 'spk',
  signedPrekeySignature: 'sig',
  signedPrekeyId: 7,
  oneTimePrekey: 'opk',
  oneTimePrekeyId: 9,
};

describe('x3dhSafe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentDeviceId.mockReturnValue('device-1234567890abcdef');
    mocks.isDeviceIdTemporary.mockReturnValue(false);
    mocks.coreInitiate.mockResolvedValue(initiatorResult);
    mocks.deviceRespond.mockResolvedValue(responderResult);
    mocks.generateDeviceSignedPrekey.mockResolvedValue({ spkId: 7, publicKey: 'spk', signature: 'sig' });
    mocks.refreshDeviceSignedPrekey.mockResolvedValue(undefined);
    mocks.refillDeviceOneTimePrekeys.mockResolvedValue(undefined);
  });

  it('routes current 4-DH handshakes to the device responder', async () => {
    const initial = { ik: 'ik', ek: 'ek', spkId: 7, opkId: 9 };
    await x3dhRespond(keys, 'user-id', initial);

    expect(mocks.deviceRespond).toHaveBeenCalledWith(
      keys,
      'user-id',
      'device-1234567890abcdef',
      initial,
    );
  });

  it('rejects legacy account 3-DH responder messages', async () => {
    await expect(x3dhRespond(keys, 'user-id', {
      ik: 'ik',
      ek: 'ek',
      spkId: 7,
    })).rejects.toThrow('X3DH_LEGACY_DISABLED: ACCOUNT_BUNDLE');

    expect(mocks.deviceRespond).not.toHaveBeenCalled();
  });

  it('rejects initiator bundles without a device OPK', async () => {
    await expect(x3dhInitiate(keys, {
      ...deviceBundle,
      oneTimePrekey: undefined,
      oneTimePrekeyId: undefined,
    })).rejects.toThrow('X3DH_LEGACY_DISABLED: MISSING_OPK');

    expect(mocks.coreInitiate).not.toHaveBeenCalled();
  });

  it('allows only the device-scoped bundle with a valid OPK', async () => {
    await expect(x3dhInitiate(keys, deviceBundle)).resolves.toBe(initiatorResult);
    expect(mocks.coreInitiate).toHaveBeenCalledWith(keys, deviceBundle);
  });

  it('fails closed while the device identifier is temporary', async () => {
    mocks.isDeviceIdTemporary.mockReturnValue(true);
    await expect(x3dhRespond(keys, 'user-id', {
      ik: 'ik',
      ek: 'ek',
      spkId: 7,
      opkId: 9,
    })).rejects.toThrow('X3DH_DEVICE_ID_NOT_STABLE');

    expect(mocks.deviceRespond).not.toHaveBeenCalled();
  });

  it('provisions only device-scoped SPKs and replenishes OPKs', async () => {
    const signingKey = {} as CryptoKey;
    await generateAndUploadSignedPrekey('user-id', signingKey);

    expect(mocks.generateDeviceSignedPrekey).toHaveBeenCalledWith(
      'user-id',
      'device-1234567890abcdef',
      signingKey,
    );
    expect(mocks.refillDeviceOneTimePrekeys).toHaveBeenCalledWith(
      'user-id',
      'device-1234567890abcdef',
    );
  });

  it('refreshes only the device-scoped route and its OPK pool', async () => {
    const signingKey = {} as CryptoKey;
    await refreshSignedPrekeyIfNeeded('user-id', signingKey);

    expect(mocks.refreshDeviceSignedPrekey).toHaveBeenCalledWith(
      'user-id',
      'device-1234567890abcdef',
      signingKey,
    );
    expect(mocks.refillDeviceOneTimePrekeys).toHaveBeenCalledWith(
      'user-id',
      'device-1234567890abcdef',
    );
  });
});
