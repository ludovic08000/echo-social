/**
 * Session manager — full lifecycle API for device-pair E2EE sessions.
 *
 * Owns the four phases of a (selfDevice, peerDevice) session:
 *
 *   1. **ensure**   — return a usable session, bootstrapping X3DH on miss
 *                     (mirrors `multiDeviceFanout`'s bootstrap so callers
 *                     outside the fan-out can request a session up-front).
 *   2. **encrypt**  — layered: cached Double Ratchet (v4/v5 enforced) → null
 *                     (caller falls through to multiDeviceFanout for X3DH +
 *                     legacy device-wrap).
 *   3. **inspect**  — `getSessionState` / `listActiveSessionsForPeer` give
 *                     read-only views the UI and diagnostics can consume
 *                     without poking at IndexedDB.
 *   4. **invalidate** — `invalidateSession` drops a single device-pair
 *                     session (peer rotated SPK, key restore, manual reset).
 *                     Bulk wipes go through `clearAllDeviceSessions`.
 *
 * Sesame guarantees enforced here:
 *   - existing sessions are NEVER overwritten silently.
 *   - failures fall through instead of aborting send.
 *   - new sessions use modern ratchet envelopes (`x3dh4.`/`x3dh5.`).
 *     v3 is read-only legacy.
 */
import {
  ratchetEncrypt,
  establishDeviceSession,
  invalidateDeviceSession,
  listKnownSessionIds,
  RATCHET_PREFIX_V4,
  RATCHET_PREFIX_V5,
} from '@/lib/crypto/deviceRatchet';
import {
  fetchPrekeyBundleForDevice,
  invalidateDeviceBundleCache,
  x3dhInitiate,
} from '@/lib/crypto/x3dh';
import { getOrCreateIdentityKeys } from '@/lib/crypto/keyManager';
import type { IdentityKeyPair } from '@/lib/crypto/keyManager';
import { logCryptoError } from '@/lib/crypto/errorLogger';
import type { DeviceDescriptor, SessionDescriptor, UserId } from './types';
import { describeSession, markSessionUsed } from './sessionStore';
import { isDeviceStale, resolveActiveDeviceDescriptor, selfDeviceId } from './deviceRegistry';

/**
 * Encrypt for ONE peer device. Strict modern ratchet path.
 *
 * Returns the wire string (already prefixed by the underlying layer) or
 * `null` if the cached ratchet has no usable sending chain — caller MUST
 * then run `multiDeviceFanout` which owns the X3DH + legacy fallbacks.
 *
 * Hard invariant: any non-null return value starts with `x3dh4.` or
 * `x3dh5.`. v3 envelopes are read-only legacy and will never be produced here.
 */
export async function encryptForDevice(
  senderUserId: UserId,
  peer: DeviceDescriptor,
  plaintext: string,
): Promise<string | null> {
  const me = selfDeviceId();
  const desc = describeSession(senderUserId, me, peer.userId, peer.deviceId);

  try {
    const ct = await ratchetEncrypt(senderUserId, me, peer.userId, peer.deviceId, plaintext);
    if (ct && (ct.startsWith(RATCHET_PREFIX_V4) || ct.startsWith(RATCHET_PREFIX_V5))) {
      markSessionUsed(desc.sessionId, ct.startsWith(RATCHET_PREFIX_V5) ? 'ratchet-v5' : 'ratchet-v4');
      return ct;
    }
    // Hard guard: a non-modern ciphertext escaped from the cached session —
    // drop it and let the fan-out re-bootstrap. Producing v3 here would silently
    // re-introduce the legacy single-secret HKDF for new traffic.
    if (ct) return null;
  } catch {
    /* fall through */
  }

  try {
    invalidateDeviceBundleCache(peer.userId, peer.deviceId, 'encrypt_for_device_no_session');
    const myKeys = await getOrCreateIdentityKeys(senderUserId);
    const ensured = await ensureSession(senderUserId, peer, myKeys);
    if (ensured.status === 'active') {
      const retry = await ratchetEncrypt(senderUserId, me, peer.userId, peer.deviceId, plaintext);
      if (retry && (retry.startsWith(RATCHET_PREFIX_V4) || retry.startsWith(RATCHET_PREFIX_V5))) {
        markSessionUsed(ensured.sessionId, retry.startsWith(RATCHET_PREFIX_V5) ? 'ratchet-v5' : 'ratchet-v4');
        return retry;
      }
    }
  } catch {
    /* one-shot recovery exhausted */
  }

  return null;
}

/**
 * Ensure a usable session exists with `peer`. If the cache is empty, runs
 * X3DH against the peer's published bundle and persists the new session as
 * the *initiator* — guaranteeing the next `encryptForDevice` call produces
 * a valid v4 ciphertext on the first try.
 *
 * Idempotent: returns the existing descriptor when the session is already
 * active (no destructive re-bootstrap, per Sesame).
 */
export async function ensureSession(
  senderUserId: UserId,
  peer: DeviceDescriptor,
  myKeys: IdentityKeyPair,
): Promise<SessionDescriptor> {
  const me = selfDeviceId();
  const desc = describeSession(senderUserId, me, peer.userId, peer.deviceId);

  // Already active locally — short-circuit. lastUsedAt > 0 means the cache
  // has actually been touched (not just a placeholder descriptor).
  if (desc.status === 'active' && desc.lastUsedAt > 0) return desc;

  const known = (await listKnownSessionIds(senderUserId, me)) ?? [];
  const cached = known.find(
    (s) => s.peerUserId === peer.userId && s.peerDeviceId === peer.deviceId,
  );
  if (cached) {
    markSessionUsed(desc.sessionId, 'ratchet-v4');
    return { ...desc, status: 'active', lastUsedAt: Date.now() };
  }

  // Cold path — run X3DH and seed an initiator session.
  const activePeer = await resolveActiveDeviceDescriptor(peer);
  if (!activePeer || isDeviceStale(activePeer)) {
    logCryptoError({
      severity: 'info',
      context: 'fanout',
      errorCode: 'E_SKIP_STALE_DEVICE',
      errorMessage: 'Skipped X3DH bootstrap for stale or revoked peer device',
      myDeviceId: me,
      peerUserId: peer.userId,
      peerDeviceId: peer.deviceId,
      metadata: {
        lastSeen: activePeer?.lastSeen ?? peer.lastSeen,
        revokedAt: activePeer?.revokedAt ?? peer.revokedAt,
        staleAt: activePeer?.staleAt ?? peer.staleAt,
        isActive: activePeer?.isActive ?? peer.isActive,
        hasActiveSignedPrekey: activePeer?.hasActiveSignedPrekey ?? peer.hasActiveSignedPrekey,
        signatureInvalid: activePeer?.signatureInvalid ?? peer.signatureInvalid,
      },
    });
    return desc;
  }

  const bundle = await fetchPrekeyBundleForDevice(activePeer.userId, activePeer.deviceId, {
    forceRefresh: true,
    retryOnInvalidSignature: true,
  });
  if (!bundle) return desc; // no published bundle — caller falls through to legacy

  const x3dh = await x3dhInitiate(myKeys, bundle);
  await establishDeviceSession(
    senderUserId, me, activePeer.userId, activePeer.deviceId,
    x3dh.sharedSecret,
    undefined,
    {
      isInitiator: true,
      peerInitialDhPubB64: bundle.signedPrekey ?? null,
      peerSpkId: bundle.signedPrekeyId ?? null,
    },
  );
  markSessionUsed(desc.sessionId, 'x3dh-bootstrap');
  return { ...desc, status: 'active', lastUsedAt: Date.now(), layer: 'x3dh-bootstrap' };
}

/**
 * Read-only descriptor for a single device pair. Useful for UI labels
 * ("session active since X") without touching IndexedDB.
 */
export function getSessionState(
  senderUserId: UserId,
  peer: DeviceDescriptor,
): SessionDescriptor {
  return describeSession(senderUserId, selfDeviceId(), peer.userId, peer.deviceId);
}

/**
 * Enumerate every locally cached session for a given peer user (across all
 * their devices). Drives multi-device diagnostic views and the fallback
 * router's session probing.
 */
export async function listActiveSessionsForPeer(
  senderUserId: UserId,
  peerUserId: UserId,
): Promise<Array<{ peerDeviceId: string; sessionId: string; lastUsedAt: number }>> {
  const me = selfDeviceId();
  const known = (await listKnownSessionIds(senderUserId, me)) ?? [];
  return known
    .filter((s) => s.peerUserId === peerUserId)
    .map((s) => ({
      peerDeviceId: s.peerDeviceId,
      sessionId: s.sessionId,
      lastUsedAt: s.lastUsedAt,
    }));
}

/**
 * Drop the cached session for one peer device. Used when:
 *  - the peer's SignedPreKey id has changed (forces fresh X3DH on next send)
 *  - the user manually resets a chat
 *  - key restore from backup (old session is no longer derivable)
 *
 * Sesame note: this does NOT touch the peer's other device sessions. Bulk
 * resets must go through `clearAllDeviceSessions` in `deviceRatchet.ts`.
 */
export async function invalidateSession(
  senderUserId: UserId,
  peer: DeviceDescriptor,
): Promise<void> {
  await invalidateDeviceSession(senderUserId, selfDeviceId(), peer.userId, peer.deviceId);
}
