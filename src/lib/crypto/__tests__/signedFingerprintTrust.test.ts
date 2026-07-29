import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getIdentity: vi.fn(),
  getAuthUserId: vi.fn(),
  fetchPeer: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/crypto/keyManager', () => ({
  getOrCreateIdentityKeys: mocks.getIdentity,
}));
vi.mock('@/lib/crypto/peerKeyCache', () => ({
  getCachedAuthUserId: mocks.getAuthUserId,
  fetchPeerPublicKeys: mocks.fetchPeer,
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: mocks.from },
}));

import { hardCrypto } from '@/lib/crypto/cryptoIntegrity';
import { bufferToBase64 } from '@/lib/crypto/utils';
import { __test__ } from '@/lib/crypto/fingerprintTracker';

const FP = 'AA'.repeat(40);

beforeEach(async () => {
  vi.clearAllMocks();
  const pair = await hardCrypto.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  mocks.getIdentity.mockResolvedValue({
    signingPrivateKey: pair.privateKey,
    signingPublicKey: pair.publicKey,
  });
});

describe('signed cross-device fingerprint trust', () => {
  it('accepts only a row signed by the observer account key', async () => {
    const input = {
      observerUserId: '11111111-1111-4111-8111-111111111111',
      peerUserId: '22222222-2222-4222-8222-222222222222',
      fingerprint: FP,
      acknowledged: true,
      verifiedManually: true,
    };
    const signature = await __test__.signTrustPayload(input);
    expect(await __test__.verifyTrustRow({
      observerUserId: input.observerUserId,
      peerUserId: input.peerUserId,
      row: {
        fingerprint: FP,
        acknowledged: true,
        verified_manually: true,
        trust_version: 1,
        observer_signature: signature,
      },
    })).toBe(true);

    expect(await __test__.verifyTrustRow({
      observerUserId: input.observerUserId,
      peerUserId: input.peerUserId,
      row: {
        fingerprint: 'BB'.repeat(40),
        acknowledged: true,
        verified_manually: true,
        trust_version: 1,
        observer_signature: signature,
      },
    })).toBe(false);
  });

  it('binds manual-verification flags inside the signature', async () => {
    const payload = __test__.canonicalTrustPayload({
      observerUserId: '11111111-1111-4111-8111-111111111111',
      peerUserId: '22222222-2222-4222-8222-222222222222',
      fingerprint: FP,
      acknowledged: true,
      verifiedManually: true,
    });
    expect(payload).toContain('forsure-aegis-known-fingerprint');
    expect(payload).toContain('"verifiedManually":true');
    expect(bufferToBase64(new TextEncoder().encode(payload).buffer as ArrayBuffer)).not.toContain(FP);
  });
});
