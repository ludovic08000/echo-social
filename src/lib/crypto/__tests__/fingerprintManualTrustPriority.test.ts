import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCachedAuthUserId: vi.fn(),
  upsert: vi.fn(),
  maybeSingle: vi.fn(),
  from: vi.fn(),
}));

vi.mock('@/lib/crypto/peerKeyCache', () => ({
  fetchPeerPublicKeys: vi.fn(),
  getCachedAuthUserId: mocks.getCachedAuthUserId,
}));

vi.mock('@/integrations/supabase/client', () => {
  const chain: Record<string, any> = {};
  chain.upsert = mocks.upsert;
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.maybeSingle = mocks.maybeSingle;
  mocks.from.mockImplementation(() => chain);
  return { supabase: { from: mocks.from } };
});

import {
  checkFingerprintChangeWithServer,
  getKnownFingerprints,
  saveKnownFingerprintServer,
} from '@/lib/crypto/fingerprintTracker';

const storage = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  },
});

describe('manual fingerprint trust priority', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
    mocks.getCachedAuthUserId.mockResolvedValue('observer-1');
    mocks.upsert.mockResolvedValue({ error: null });
    mocks.maybeSingle.mockResolvedValue({
      data: { fingerprint: 'OLD-FINGERPRINT' },
      error: null,
    });
  });

  it('prioritizes the exact fingerprint explicitly trusted by the user over stale reads', async () => {
    await expect(
      saveKnownFingerprintServer('peer-1', 'NEW-FINGERPRINT', true),
    ).resolves.toBe(true);

    expect(getKnownFingerprints()['peer-1']).toBe('NEW-FINGERPRINT');

    await expect(
      checkFingerprintChangeWithServer('observer-1', 'peer-1', 'NEW-FINGERPRINT'),
    ).resolves.toEqual({ changed: false, previousFp: null });

    // The explicit acknowledgement is used before any stale server read.
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
  });
});
