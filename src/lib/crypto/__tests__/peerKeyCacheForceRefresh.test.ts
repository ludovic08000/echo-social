import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
}));

vi.mock('@/integrations/supabase/client', () => {
  const chain: Record<string, any> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.maybeSingle = mocks.maybeSingle;
  return {
    supabase: {
      from: vi.fn(() => chain),
      auth: { getUser: vi.fn() },
    },
  };
});

vi.mock('@/lib/crypto/keyManager', () => ({
  verifyPublicIdentityBinding: vi.fn(async () => true),
}));

import {
  _peerKeyCache,
  _peerSyncPromise,
  fetchPeerPublicKeys,
  type PeerPublicKeys,
} from '@/lib/crypto/peerKeyCache';

const stale: PeerPublicKeys = {
  identity_key: 'old-identity',
  signing_key: 'old-signing',
  fingerprint: 'OLD',
  identity_binding_version: 1,
  identity_binding_signature: 'old-signature',
};

describe('forced peer-key refresh', () => {
  beforeEach(() => {
    _peerKeyCache.clear();
    _peerSyncPromise.clear();
    vi.clearAllMocks();
  });

  it('returns null and removes the stale cache when the network refresh fails', async () => {
    _peerKeyCache.set('peer-1', { data: stale, ts: Date.now() });
    mocks.maybeSingle.mockResolvedValue({
      data: null,
      error: { message: 'offline' },
    });

    await expect(fetchPeerPublicKeys('peer-1', { forceRefresh: true })).resolves.toBeNull();
    expect(_peerKeyCache.has('peer-1')).toBe(false);
  });
});
