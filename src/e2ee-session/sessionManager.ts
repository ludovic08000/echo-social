/**
 * Session manager — full lifecycle API for device-pair E2EE sessions.
 *
 * Owns the four phases of a (selfDevice, peerDevice) session:
 *
 *   1. **ensure**   — return a usable session, bootstrapping X3DH on miss
 *                     (mirrors `multiDeviceFanout`'s bootstrap so callers
 *                     outside the fan-out can request a session up-front).
 *   2. **encrypt**  — layered: cached Double Ratchet (v5/v4 modern) → null
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
 *   - new sessions use the modern ratchet wire formats (`x3dh5.` preferred,
 *     `x3dh4.` still accepted). v3 is read-only legacy and is never produced.
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
  isDevicePrekeyBundleError,
  x3dhInitiate,
} from '@/lib/crypto/x3dh';
import type { IdentityKeyPair } from '@/lib/crypto/keyManager';
import type { DeviceDescriptor, SessionDescriptor, UserId } from './types';
import { describeSession, markSessionUsed } from './sessionStore';
import { selfDeviceId } from './deviceRegistry';

function modernRatchetLayer(ciphertext: string): 'ratchet-v5' | 'ratchet-v4' | null {
  if (ciphertext.startsWith(RATCHET_PREFIX_V5)) return 'ratchet-v5';
  if (ciphertext.startsWith(RATCHET_PREFIX_V4)) return 'ratchet-v4';
  return null;
}

/**
 * Encrypt for ONE peer device.
 *
 * Returns the wire string (already prefixed by the underlying layer) or
 * `null` if the cached ratchet has no usable sending chain — caller MUST
 * then run `multiDeviceFanout` which owns the X3DH + legacy fallbacks.
 *
 * Hard invariant: any non-null return value is a modern ratchet envelope
 * (`x3dh5.` or `x3dh4.`). v3 envelopes are read-only legacy and will never
 * be produced from this manager.
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
    if (ct) {
      const layer = modernRatchetLayer(ct);
      if (layer) {
        markSessionUsed(desc.sessionId, layer);
        return ct;
      }

      // Hard guard: a non-modern ciphertext escaped from the cached session —
      // drop it and let the fan-out re-bootstrap. Producing v3 here would
      // silently re-introduce the legacy single-secret HKDF for new traffic.
      return null;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Ensure a usable session exists with `peer`. If the cache is empty, runs
 * X3DH against the peer's published bundle and persists the new session as
 * the *initiator* — guaranteeing the next `encryptForDevice` call produces
 * a valid modern ciphertext on the first try.
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
    markSessionUsed(desc.sessionId, 'ratchet-v5');
    return { ...desc, status: 'active', lastUsedAt: Date.now(), layer: 'ratchet-v5' };
  }

  // Cold path — run X3DH and seed an initiator session.
  let bundle = null as Awaited<ReturnType<typeof fetchPrekeyBundleForDevice>>;
  try {
    bundle = await fetchPrekeyBundleForDevice(peer.userId, peer.deviceId);
  } catch (e) {
    if (isDevicePrekeyBundleError(e, 'DEVICE_SPK_SIGNATURE_INVALID') && typeof console !== 'undefined') {
      console.warn('[sessionManager] refusing X3DH bootstrap for device with invalid SPK', {
        peerUserId: peer.userId,
        peerDeviceId: peer.deviceId,
      });
    }
    return desc;
  }
  if (!bundle) return desc; // no published bundle — caller falls through to legacy

  const x3dh = await x3dhInitiate(myKeys, bundle);
  await establishDeviceSession(
    senderUserId, me, peer.userId, peer.deviceId,
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
