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

    expect(getKnownFingerprints()['observer-1:peer-pinned']).toBe('FINGERPRINT-1');

    mocks.maybeSingle.mockResolvedValue({
      data: { fingerprint: 'FINGERPRINT-1' },
      error: null,
    });

    await expect(
      checkFingerprintChangeWithServer('observer-1', 'peer-pinned', 'FINGERPRINT-2'),
    ).resolves.toEqual({ changed: true, previousFp: 'FINGERPRINT-1' });

    expect(getKnownFingerprints()['observer-1:peer-pinned']).toBe('FINGERPRINT-1');
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

    expect(getKnownFingerprints()['observer-2:peer-restored']).toBe('SERVER-PINNED');

    await expect(
      checkFingerprintChangeWithServer('observer-2', 'peer-restored', 'SERVER-REPLACEMENT'),
    ).resolves.toEqual({ changed: true, previousFp: 'SERVER-PINNED' });

    expect(getKnownFingerprints()['observer-2:peer-restored']).toBe('SERVER-PINNED');
    expect(mocks.maybeSingle).toHaveBeenCalledTimes(2);
    expect(mocks.recordIdentityChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the synchronous local guard strict after an explicit verification', async () => {
    await expect(
      saveKnownFingerprintServer('peer-local', 'LOCAL-PINNED', true),
    ).resolves.toBe(true);

    expect(checkFingerprintChange('observer-1', 'peer-local', 'LOCAL-PINNED')).toBe(false);
    expect(checkFingerprintChange('observer-1', 'peer-local', 'LOCAL-REPLACEMENT')).toBe(true);
  });

  it('still treats first contact as TOFU but records later identity replacement', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: null, error: null });

    await expect(
      checkFingerprintChangeWithServer('observer-3', 'peer-new', 'FIRST-FINGERPRINT'),
    ).resolves.toEqual({ changed: false, previousFp: null });

    saveKnownFingerprint('observer-3', 'peer-new', 'FIRST-FINGERPRINT');
    mocks.maybeSingle.mockResolvedValue({
      data: { fingerprint: 'FIRST-FINGERPRINT' },
      error: null,
    });

    await expect(
      checkFingerprintChangeWithServer('observer-3', 'peer-new', 'SECOND-FINGERPRINT'),
    ).resolves.toEqual({ changed: true, previousFp: 'FIRST-FINGERPRINT' });

    expect(mocks.recordIdentityChange).toHaveBeenCalledTimes(1);
  });

  it('never lets the server replace a locally pinned identity without consent', async () => {
    saveKnownFingerprint('observer-1', 'peer-server-replaced', 'LOCAL-PINNED');
    mocks.maybeSingle.mockResolvedValue({ data: { fingerprint: 'SERVER-REPLACEMENT' }, error: null });

    await expect(checkFingerprintChangeWithServer(
      'observer-1', 'peer-server-replaced', 'SERVER-REPLACEMENT',
    )).resolves.toEqual({ changed: true, previousFp: 'LOCAL-PINNED' });
    expect(getKnownFingerprints()['observer-1:peer-server-replaced']).toBe('LOCAL-PINNED');
  });

  it('keeps a locally verified identity usable when the server pin is stale', async () => {
    saveKnownFingerprint('observer-1', 'peer-server-stale', 'LOCAL-PINNED');
    mocks.maybeSingle.mockResolvedValue({ data: { fingerprint: 'SERVER-OLD' }, error: null });

    await expect(checkFingerprintChangeWithServer(
      'observer-1', 'peer-server-stale', 'LOCAL-PINNED',
    )).resolves.toEqual({ changed: false, previousFp: null });
  });

  it('does not reuse an approval cached before a local trust change in another tab', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { fingerprint: 'FIRST' }, error: null });
    await checkFingerprintChangeWithServer('observer-1', 'peer-cache', 'FIRST');
    // Simulate another tab changing shared storage without this module's invalidator.
    localStorage.setItem('forsure-known-fps', JSON.stringify({ 'observer-1:peer-cache': 'VERIFIED-NEW' }));

    await expect(checkFingerprintChangeWithServer('observer-1', 'peer-cache', 'FIRST'))
      .resolves.toEqual({ changed: true, previousFp: 'VERIFIED-NEW' });
  });

  it('rechecks the local pin after an in-flight server lookup', async () => {
    let finish!: (value: unknown) => void;
    mocks.maybeSingle.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const check = checkFingerprintChangeWithServer('observer-1', 'peer-race', 'SERVER-KEY');
    saveKnownFingerprint('observer-1', 'peer-race', 'LOCALLY-VERIFIED');
    finish({ data: { fingerprint: 'SERVER-KEY' }, error: null });

    await expect(check).resolves.toEqual({ changed: true, previousFp: 'LOCALLY-VERIFIED' });
    expect(getKnownFingerprints()['observer-1:peer-race']).toBe('LOCALLY-VERIFIED');
  });

  it('rejects automatic saves that would replace a known local identity', async () => {
    saveKnownFingerprint('observer-1', 'peer-auto', 'LOCAL-PINNED');
    await expect(saveKnownFingerprintServer('peer-auto', 'REPLACEMENT')).resolves.toBe(false);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(getKnownFingerprints()['observer-1:peer-auto']).toBe('LOCAL-PINNED');
  });

  it('does not overwrite a pin created while an automatic save was in flight', async () => {
    let finish!: (value: unknown) => void;
    mocks.upsert.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const save = saveKnownFingerprintServer('peer-save-race', 'FIRST');
    await vi.waitFor(() => expect(mocks.upsert).toHaveBeenCalled());
    saveKnownFingerprint('observer-1', 'peer-save-race', 'LOCALLY-VERIFIED');
    finish({ error: null });

    await expect(save).resolves.toBe(false);
    expect(getKnownFingerprints()['observer-1:peer-save-race']).toBe('LOCALLY-VERIFIED');
  });

  it('still permits an explicit manual verification of a new identity', async () => {
    saveKnownFingerprint('observer-1', 'peer-manual', 'OLD');
    await expect(saveKnownFingerprintServer('peer-manual', 'VERIFIED-NEW', true)).resolves.toBe(true);
    expect(getKnownFingerprints()['observer-1:peer-manual']).toBe('VERIFIED-NEW');
  });
});
