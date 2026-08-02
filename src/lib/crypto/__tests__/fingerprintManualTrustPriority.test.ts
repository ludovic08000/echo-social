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
  checkFingerprintChangeWithServer,
  getKnownFingerprints,
  getManuallyTrustedContacts,
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

describe('permanent manual contact trust', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
    mocks.getCachedAuthUserId.mockResolvedValue('observer-1');
    mocks.upsert.mockResolvedValue({ error: null });
    mocks.maybeSingle.mockResolvedValue({
      data: { fingerprint: 'OLD-FINGERPRINT', verified_manually: false },
      error: null,
    });
  });

  it('keeps the contact trusted across every later fingerprint rotation', async () => {
    await expect(
      saveKnownFingerprintServer('peer-permanent', 'FINGERPRINT-1', true),
    ).resolves.toBe(true);

    expect(getManuallyTrustedContacts()['observer-1:peer-permanent']).toBe(true);

    await expect(
      checkFingerprintChangeWithServer('observer-1', 'peer-permanent', 'FINGERPRINT-2'),
    ).resolves.toEqual({ changed: false, previousFp: null });
    expect(getKnownFingerprints()['peer-permanent']).toBe('FINGERPRINT-2');

    await expect(
      checkFingerprintChangeWithServer('observer-1', 'peer-permanent', 'FINGERPRINT-3'),
    ).resolves.toEqual({ changed: false, previousFp: null });
    expect(getKnownFingerprints()['peer-permanent']).toBe('FINGERPRINT-3');

    // Permanent local contact trust is evaluated before stale server reads.
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
    expect(mocks.recordIdentityChange).not.toHaveBeenCalled();
  });

  it('restores permanent trust from the server after local storage was erased', async () => {
    mocks.maybeSingle.mockResolvedValue({
      data: { fingerprint: 'SERVER-OLD', verified_manually: true },
      error: null,
    });

    await expect(
      checkFingerprintChangeWithServer('observer-2', 'peer-restored', 'SERVER-NEW'),
    ).resolves.toEqual({ changed: false, previousFp: null });

    expect(getManuallyTrustedContacts()['observer-2:peer-restored']).toBe(true);
    expect(getKnownFingerprints()['peer-restored']).toBe('SERVER-NEW');
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(1);

    await expect(
      checkFingerprintChangeWithServer('observer-2', 'peer-restored', 'SERVER-NEWER'),
    ).resolves.toEqual({ changed: false, previousFp: null });

    expect(mocks.maybeSingle).toHaveBeenCalledTimes(1);
    expect(mocks.recordIdentityChange).not.toHaveBeenCalled();
  });

  it('still blocks a changed fingerprint for a contact never manually trusted', async () => {
    saveKnownFingerprint('peer-untrusted', 'UNTRUSTED-OLD');
    mocks.maybeSingle.mockResolvedValue({
      data: { fingerprint: 'UNTRUSTED-OLD', verified_manually: false },
      error: null,
    });

    await expect(
      checkFingerprintChangeWithServer('observer-3', 'peer-untrusted', 'UNTRUSTED-NEW'),
    ).resolves.toEqual({ changed: true, previousFp: 'UNTRUSTED-OLD' });

    expect(mocks.recordIdentityChange).toHaveBeenCalledTimes(1);
  });
});
