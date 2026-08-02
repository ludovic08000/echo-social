import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCachedAuthUserId: vi.fn(),
  upsert: vi.fn(),
  maybeSingle: vi.fn(),
  from: vi.fn(),
  recordIdentityChange: vi.fn(),
}));

vi.mock('@/lib/crypto/peerKeyCache', () => ({
  fetchPeerPublicKeys: vi.fn(),
  getCachedAuthUserId: mocks.getCachedAuthUserId,
}));

vi.mock('@/lib/crypto/identityChangeLedger', () => ({
  recordIdentityChange: mocks.recordIdentityChange,
}));

vi.mock('@/lib/crypto/recoveryMarkers', () => ({
  peerHasRecentRecoveryMarker: vi.fn(async () => false),
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
  checkFingerprintChange,
  checkFingerprintChangeWithServer,
  getKnownFingerprints,
  saveKnownFingerprint,
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

describe('exact account identity pinning', () => {
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

  it('blocks every later account fingerprint after the user verified one exact identity', async () => {
    await expect(
      saveKnownFingerprintServer('peer-pinned', 'FINGERPRINT-1', true),
    ).resolves.toBe(true);

    expect(getKnownFingerprints()['peer-pinned']).toBe('FINGERPRINT-1');

    mocks.maybeSingle.mockResolvedValue({
      data: { fingerprint: 'FINGERPRINT-1' },
      error: null,
    });

    await expect(
      checkFingerprintChangeWithServer('observer-1', 'peer-pinned', 'FINGERPRINT-2'),
    ).resolves.toEqual({ changed: true, previousFp: 'FINGERPRINT-1' });

    expect(getKnownFingerprints()['peer-pinned']).toBe('FINGERPRINT-1');
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(1);
    expect(mocks.recordIdentityChange).toHaveBeenCalledTimes(1);
  });

  it('restores the exact pinned fingerprint after local storage was erased', async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { fingerprint: 'SERVER-PINNED' },
      error: null,
    });

    await expect(
      checkFingerprintChangeWithServer('observer-2', 'peer-restored', 'SERVER-PINNED'),
    ).resolves.toEqual({ changed: false, previousFp: null });

    expect(getKnownFingerprints()['peer-restored']).toBe('SERVER-PINNED');

    await expect(
      checkFingerprintChangeWithServer('observer-2', 'peer-restored', 'SERVER-REPLACEMENT'),
    ).resolves.toEqual({ changed: true, previousFp: 'SERVER-PINNED' });

    expect(getKnownFingerprints()['peer-restored']).toBe('SERVER-PINNED');
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(2);
    expect(mocks.recordIdentityChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the synchronous local guard strict after an explicit verification', async () => {
    await expect(
      saveKnownFingerprintServer('peer-local', 'LOCAL-PINNED', true),
    ).resolves.toBe(true);

    expect(checkFingerprintChange('peer-local', 'LOCAL-PINNED')).toBe(false);
    expect(checkFingerprintChange('peer-local', 'LOCAL-REPLACEMENT')).toBe(true);
  });

  it('still treats first contact as TOFU but records later identity replacement', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(
      checkFingerprintChangeWithServer('observer-3', 'peer-new', 'FIRST-FINGERPRINT'),
    ).resolves.toEqual({ changed: false, previousFp: null });

    saveKnownFingerprint('peer-new', 'FIRST-FINGERPRINT');
    mocks.maybeSingle.mockResolvedValue({
      data: { fingerprint: 'FIRST-FINGERPRINT' },
      error: null,
    });

    await expect(
      checkFingerprintChangeWithServer('observer-3', 'peer-new', 'SECOND-FINGERPRINT'),
    ).resolves.toEqual({ changed: true, previousFp: 'FIRST-FINGERPRINT' });

    expect(mocks.recordIdentityChange).toHaveBeenCalledTimes(1);
  });
});
