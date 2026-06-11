/**
 * Fallback decrypt — integration tests for the multi-session router.
 *
 * Validates:
 *  - Primary ratchet path succeeds when the session matches the header.
 *  - Falls back to the per-message device-copy path when the ratchet fails.
 *  - Surfaces typed errorCodes (NOT_RATCHET_CIPHERTEXT, RATCHET_SESSION_UNKNOWN,
 *    NO_PEER_DEVICES, ALL_RATCHET_SESSIONS_FAILED) so the UI can react correctly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mocks must be declared BEFORE importing the module under test.
vi.mock('@/lib/crypto/deviceRatchet', async () => {
  const actual = await vi.importActual<typeof import('@/lib/crypto/deviceRatchet')>(
    '@/lib/crypto/deviceRatchet',
  );
  return {
    ...actual,
    ratchetDecrypt: vi.fn(),
    listKnownSessionIds: vi.fn(),
  };
});
vi.mock('../deviceRegistry', () => ({
  selfDeviceId: () => 'self-dev-1',
  listDevicesForUser: vi.fn(),
  isSelfDeviceIdTemporary: () => false,
}));
vi.mock('../legacyDecryptRouter', () => ({
  legacyDecryptByMessageId: vi.fn(),
  isKnownLegacyFormat: () => false,
}));

import { tryEveryRatchetSession } from '@/e2ee-session/fallbackDecrypt';
import {
  ratchetDecrypt,
  listKnownSessionIds,
  RATCHET_PREFIX_V4,
} from '@/lib/crypto/deviceRatchet';
import { listDevicesForUser } from '../deviceRegistry';
import { legacyDecryptByMessageId } from '../legacyDecryptRouter';

const PEER = 'user-bob';
const ME = 'user-alice';

function makeV4Ciphertext(sessionId = 'sess-1'): string {
  // Shape only — fallbackDecrypt routes by prefix + header sessionId, not real crypto.
  return `${RATCHET_PREFIX_V4}${sessionId}.AAAA.0.0.AAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB`;
}

describe('fallbackDecrypt.tryEveryRatchetSession', () => {
  beforeEach(() => {
    // Hard reset of all mock state, including pending mockResolvedValue
    // queues left over from earlier tests (avoids cross-test bleed).
    vi.resetAllMocks();
    (ratchetDecrypt as any).mockReset();
    (listKnownSessionIds as any).mockReset();
    (listDevicesForUser as any).mockReset();
    (legacyDecryptByMessageId as any).mockReset();
    // Default safe baselines — overridden per-test as needed.
    (ratchetDecrypt as any).mockResolvedValue(null);
    (listKnownSessionIds as any).mockResolvedValue([]);
    (listDevicesForUser as any).mockResolvedValue([]);
    (legacyDecryptByMessageId as any).mockResolvedValue({ ok: false, plaintext: null });
  });

  it('returns NOT_RATCHET_CIPHERTEXT for non-ratchet payloads', async () => {
    const r = await tryEveryRatchetSession(ME, PEER, '{"some":"json-envelope"}');
    expect(r).toEqual({ ok: false, plaintext: null, errorCode: 'NOT_RATCHET_CIPHERTEXT' });
  });

  it('returns plaintext when the primary ratchet decrypt succeeds', async () => {
    (ratchetDecrypt as any).mockResolvedValue('hello world');
    const r = await tryEveryRatchetSession(ME, PEER, makeV4Ciphertext());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plaintext).toBe('hello world');
      expect(r.via).toBe('fallback-session');
    }
  });

  it('falls back to the device-copy path when the ratchet returns null', async () => {
    (ratchetDecrypt as any).mockResolvedValue(null);
    (listKnownSessionIds as any).mockResolvedValue([
      { peerUserId: PEER, peerDeviceId: 'dev-bob-1', sessionId: 'sess-1', lastUsedAt: 0 },
    ]);
    (listDevicesForUser as any).mockResolvedValue([
      { userId: PEER, deviceId: 'dev-bob-1', devicePublicKey: 'k' },
    ]);
    (legacyDecryptByMessageId as any).mockResolvedValue({
      ok: true, plaintext: 'recovered via copy', via: 'device-copy',
    });

    const r = await tryEveryRatchetSession(ME, PEER, makeV4Ciphertext('sess-1'), 'msg-123');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plaintext).toBe('recovered via copy');
      expect(r.via).toBe('fallback-device-copy');
    }
    expect(legacyDecryptByMessageId).toHaveBeenCalledWith('msg-123', PEER);
  });

  it('reports RATCHET_SESSION_UNKNOWN when peer rotated SPK / sessionId mismatch', async () => {
    (ratchetDecrypt as any).mockResolvedValue(null);
    (listKnownSessionIds as any).mockResolvedValue([
      // We have a session with this peer, but under a DIFFERENT id.
      { peerUserId: PEER, peerDeviceId: 'dev-bob-1', sessionId: 'sess-OLD', lastUsedAt: 0 },
    ]);
    (listDevicesForUser as any).mockResolvedValue([
      { userId: PEER, deviceId: 'dev-bob-1', devicePublicKey: 'k' },
    ]);

    const r = await tryEveryRatchetSession(ME, PEER, makeV4Ciphertext('sess-NEW'));
    expect(r).toEqual({
      ok: false, plaintext: null, errorCode: 'RATCHET_SESSION_UNKNOWN',
    });
  });

  it('reports NO_PEER_DEVICES when the peer has no published devices', async () => {
    (ratchetDecrypt as any).mockResolvedValue(null);
    (legacyDecryptByMessageId as any).mockResolvedValue({ ok: false, plaintext: null });
    (listKnownSessionIds as any).mockResolvedValue([]);
    (listDevicesForUser as any).mockResolvedValue([]);

    const r = await tryEveryRatchetSession(ME, PEER, makeV4Ciphertext('sess-X'));
    expect(r).toEqual({
      ok: false, plaintext: null, errorCode: 'NO_PEER_DEVICES',
    });
  });

  it('reports ALL_RATCHET_SESSIONS_FAILED on out-of-order with known sessionId', async () => {
    (ratchetDecrypt as any).mockResolvedValue(null);
    (legacyDecryptByMessageId as any).mockResolvedValue({ ok: false, plaintext: null });
    (listKnownSessionIds as any).mockResolvedValue([
      { peerUserId: PEER, peerDeviceId: 'dev-bob-1', sessionId: 'sess-OK', lastUsedAt: 0 },
    ]);
    (listDevicesForUser as any).mockResolvedValue([
      { userId: PEER, deviceId: 'dev-bob-1', devicePublicKey: 'k' },
    ]);
    // Header sessionId matches a known session AND peer has devices →
    // out-of-order delivery, pending queue will retry.
    const r = await tryEveryRatchetSession(ME, PEER, makeV4Ciphertext('sess-OK'));
    expect(r).toEqual({
      ok: false, plaintext: null, errorCode: 'ALL_RATCHET_SESSIONS_FAILED',
    });
  });

  it('does not throw when the primary ratchet rejects', async () => {
    (ratchetDecrypt as any).mockRejectedValue(new Error('boom'));
    (listKnownSessionIds as any).mockResolvedValue([]);
    (listDevicesForUser as any).mockResolvedValue([]);
    const r = await tryEveryRatchetSession(ME, PEER, makeV4Ciphertext());
    expect(r.ok).toBe(false);
  });
});
