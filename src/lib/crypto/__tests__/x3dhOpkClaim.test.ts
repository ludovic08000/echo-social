import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  verify: vi.fn(),
  fetchVerifiedDeviceIdentity: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc },
}));

vi.mock('@/lib/crypto/cryptoIntegrity', () => ({
  hardCrypto: { verify: mocks.verify },
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
}));

vi.mock('@/lib/crypto/canonicalDeviceRegistry', () => ({
  fetchVerifiedDeviceIdentity: mocks.fetchVerifiedDeviceIdentity,
}));

import { fetchPrekeyBundleForDevice } from '@/lib/crypto/x3dh';

function installPrekeyResponses() {
  mocks.fetchVerifiedDeviceIdentity.mockResolvedValue({
    deviceId: 'peer-device',
    devicePublicKey: 'AA==',
    deviceSigningKey: 'AA==',
  });
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_device_prekey_bundle') {
      return { data: [{ spk_id: 7, public_key: 'AA==', signature: 'AA==' }], error: null };
    }
    if (name === 'claim_device_one_time_prekey') {
      return { data: [{ opk_id: 42, public_key: 'AA==' }], error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  });
}

function opkClaimCalls() {
  return mocks.rpc.mock.calls.filter(([name]) => name === 'claim_device_one_time_prekey');
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
      conversationId: '11111111-1111-4111-8111-111111111111',
      senderDeviceId: 'sender-device',
    });
    expect(bundle).toMatchObject({ signedPrekeyId: 7 });
    expect(bundle?.oneTimePrekey).toBeUndefined();
    expect(opkClaimCalls()).toHaveLength(0);
  });

  it('uses SPK-only X3DH when no sending relationship authorizes a claim', async () => {
    const bundle = await fetchPrekeyBundleForDevice('peer-user', 'peer-device');
    expect(bundle?.oneTimePrekeyId).toBeUndefined();
    expect(opkClaimCalls()).toHaveLength(0);
  });

  it('claims exactly one OPK and binds it to the conversation and sender device', async () => {
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const bundle = await fetchPrekeyBundleForDevice('peer-user', 'peer-device', {
      conversationId,
      senderDeviceId: 'sender-device',
    });
    expect(bundle?.oneTimePrekeyId).toBe(42);
    expect(opkClaimCalls()).toHaveLength(1);
    expect(mocks.rpc).toHaveBeenCalledWith('claim_device_one_time_prekey', {
      p_user_id: 'peer-user',
      p_device_id: 'peer-device',
      p_conversation_id: conversationId,
      p_sender_device_id: 'sender-device',
    });
  });
});
