import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
  },
}));

vi.mock('@/lib/crypto/cryptoIntegrity', () => ({
  hardCrypto: {
    verify: mocks.verify,
  },
  hardGlobals: { TextEncoder, TextDecoder },
}));

vi.mock('@/lib/crypto/utils', () => ({
  bufferToBase64: vi.fn(() => 'AA=='),
  base64ToBuffer: vi.fn(() => new Uint8Array([0]).buffer),
  concatBuffers: vi.fn(() => new ArrayBuffer(0)),
  encodeString: vi.fn(() => new Uint8Array()),
  importKeyFromJWK: vi.fn(),
  importOkpPublicKeyFromBase64: vi.fn(async () => ({})),
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  exportPublicKeyRaw: vi.fn(),
  verifyPublicIdentityBinding: vi.fn(async () => true),
}));

vi.mock('@/lib/crypto/deviceIdentity', () => ({
  verifyDeviceIdentityBinding: vi.fn(async () => true),
}));

import { fetchPrekeyBundleForDevice } from '@/lib/crypto/x3dh';

function installPrekeyResponses() {
  mocks.from.mockImplementation((table: string) => {
    if (table !== 'user_devices') throw new Error(`Unexpected table: ${table}`);
    const query = {
      select: () => query,
      eq: () => query,
      is: () => query,
      maybeSingle: async () => ({
        data: {
          device_public_key: 'AA==',
          device_signing_key: 'AA==',
          device_identity_signature: 'AA==',
          device_identity_version: 1,
        },
        error: null,
      }),
    };
    return query;
  });

  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_device_prekey_bundle') {
      return {
        data: [{ spk_id: 7, public_key: 'AA==', signature: 'AA==' }],
        error: null,
      };
    }
    if (name === 'claim_device_one_time_prekey') {
      return {
        data: [{ opk_id: 42, public_key: 'AA==' }],
        error: null,
      };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  });
}

describe('fetchPrekeyBundleForDevice OPK claiming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockResolvedValue(true);
    installPrekeyResponses();
  });

  it('does not claim a one-time prekey when explicitly disabled', async () => {
    const bundle = await fetchPrekeyBundleForDevice('peer-user', 'peer-device', {
      claimOneTimePrekey: false,
    });

    expect(bundle).toMatchObject({ signedPrekeyId: 7 });
    expect(bundle?.oneTimePrekey).toBeUndefined();
    expect(bundle?.oneTimePrekeyId).toBeUndefined();
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      'claim_device_one_time_prekey',
      expect.anything(),
    );
  });

  it('keeps claiming an OPK by default for normal X3DH bootstraps', async () => {
    const bundle = await fetchPrekeyBundleForDevice('peer-user', 'peer-device');

    expect(bundle?.oneTimePrekeyId).toBe(42);
    expect(mocks.rpc).toHaveBeenCalledWith('claim_device_one_time_prekey', {
      p_user_id: 'peer-user',
      p_device_id: 'peer-device',
    });
  });
});
