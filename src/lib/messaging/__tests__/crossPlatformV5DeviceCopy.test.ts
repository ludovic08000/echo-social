/**
 * Cross-platform v5 device copy decryption — non-regression test.
 *
 * Guards the Win↔iOS bug where `tryDecryptCopy` recognized only v3/v4
 * ratchet prefixes and let v5 (`x3dh5.`) envelopes silently fall through
 * every decoder, leaving the message displayed as ciphertext.
 *
 * The recipient-side fan-out path MUST route v3, v4 AND v5 device-pair
 * envelopes to `ratchetDecryptWithSession`. Anything else regresses
 * cross-platform first contact.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted so the vi.mock factories below can reference these handles safely.
const mocks = vi.hoisted(() => ({
  ratchetDecryptWithSession: vi.fn(),
  x3dhUnwrapForDeviceFlag: { called: false },
}));
const { ratchetDecryptWithSession, x3dhUnwrapForDeviceFlag } = mocks;

vi.mock('@/lib/crypto/deviceRatchet', () => ({
  ratchetEncrypt: vi.fn(),
  ratchetDecryptWithSession: mocks.ratchetDecryptWithSession,
  establishDeviceSession: vi.fn(),
  getSessionPeerSpkId: vi.fn(),
  invalidateDeviceSession: vi.fn(),
  RATCHET_PREFIX_V3: 'x3dh3.',
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
          x3dhUnwrapForDeviceFlag.called = true;
          return Promise.resolve({ data: null });
        } }) }),
      }),
    }),
    rpc: () => Promise.resolve({ data: [] }),
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-recipient' } } }) },
  },
}));

vi.mock('@/lib/messaging/currentDevice', () => ({
  getCurrentDeviceId: () => 'device-ios',
  isDeviceIdTemporary: () => false,
}));

vi.mock('@/lib/messaging/deviceWrap', () => ({
  wrapPlaintextForDevice: vi.fn(),
  unwrapPlaintextForDevice: vi.fn(),
}));

vi.mock('@/lib/messaging/deviceCopyRetryRequest', () => ({
  requestDeviceCopyRetry: vi.fn(),
}));

vi.mock('@/lib/crypto/x3dh', () => ({
  fetchPrekeyBundleForDevice: vi.fn(),
  peekDeviceSignedPrekey: vi.fn(),
  x3dhInitiate: vi.fn(),
  x3dhRespond: vi.fn(),
  x3dhRespondForDevice: vi.fn(),
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  getOrCreateIdentityKeys: vi.fn(),
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

import { tryDecryptDeviceTargetedBody } from '@/lib/messaging/multiDeviceFanout';

const SENDER = { user_id: 'user-windows', device_id: 'device-windows' };
const ME = { userId: 'user-recipient', deviceId: 'device-ios' };

beforeEach(() => {
  ratchetDecryptWithSession.mockReset();
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

  it('still routes legacy v4 (`x3dh4.`) copies to ratchetDecryptWithSession', async () => {
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

    expect(pt).toBe('hello v4');
    expect(ratchetDecryptWithSession).toHaveBeenCalledTimes(1);
  });

  it('still routes legacy v3 (`x3dh3.`) copies to ratchetDecryptWithSession', async () => {
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

    expect(pt).toBe('hello v3');
    expect(ratchetDecryptWithSession).toHaveBeenCalledTimes(1);
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
    // Still must not fall through to X3DH unwrap (would consume an OPK for nothing).
    expect(x3dhUnwrapForDeviceFlag.called).toBe(false);
  });
});
