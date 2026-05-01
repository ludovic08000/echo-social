/**
 * Fallback decrypt — when the primary path fails, enumerate every locally
 * known device-pair session and produce actionable diagnostics.
 *
 * Why this matters
 * ----------------
 * `ratchetDecrypt(self, me, ct)` parses the `sessionId` embedded in the
 * v3/v4 header and looks it up in IndexedDB. If the lookup misses (peer
 * rotated SPK, Keychain wipe, multi-device race), the function returns
 * `null`. Looping the same call therefore cannot help.
 *
 * What we DO here
 * ---------------
 * 1. Compare the header's sessionId against every known sessionId for the
 *    current self-device (read-only enumeration via `listKnownSessionIds`).
 * 2. If the peer is multi-device and we have at least one session for one
 *    of their other devices, log a precise mismatch so the next outgoing
 *    fan-out re-bootstraps the missing pair.
 * 3. Surface a typed errorCode the UI uses to decide between "retry later"
 *    (RATCHET_SESSION_UNKNOWN — out-of-order) and "ask user to restore"
 *    (NO_PEER_DEVICES).
 *
 * No crypto is reimplemented. No session is mutated. Strictly observational.
 */
import {
  ratchetDecrypt,
  RATCHET_PREFIX_V3,
  RATCHET_PREFIX_V4,
  listKnownSessionIds,
} from '@/lib/crypto/deviceRatchet';
import { listDevicesForUser, selfDeviceId } from './deviceRegistry';
import { legacyDecryptByMessageId } from './legacyDecryptRouter';
import type { DecryptResult, UserId } from './types';

/** Extract the sessionId from a v3/v4 ciphertext header. Returns null on parse failure. */
function readSessionIdFromHeader(encryptedBody: string): string | null {
  const prefix = encryptedBody.startsWith(RATCHET_PREFIX_V4)
    ? RATCHET_PREFIX_V4
    : encryptedBody.startsWith(RATCHET_PREFIX_V3)
      ? RATCHET_PREFIX_V3
      : null;
  if (!prefix) return null;
  const rest = encryptedBody.slice(prefix.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return null;
  return rest.slice(0, dot);
}

export async function tryEveryRatchetSession(
  recipientUserId: UserId,
  peerUserId: UserId,
  encryptedBody: string,
): Promise<DecryptResult> {
  if (
    !encryptedBody.startsWith(RATCHET_PREFIX_V3) &&
    !encryptedBody.startsWith(RATCHET_PREFIX_V4)
  ) {
    return { ok: false, plaintext: null, errorCode: 'NOT_RATCHET_CIPHERTEXT' };
  }

  const me = selfDeviceId();

  // 1) Single primary attempt — covers 99.9% of in-order traffic.
  try {
    const pt = await ratchetDecrypt(recipientUserId, me, encryptedBody);
    if (pt !== null) return { ok: true, plaintext: pt, via: 'fallback-session' };
  } catch { /* keep diagnosing */ }

  // 2) Diagnose: do we even have a session for any of this peer's devices?
  const headerSessionId = readSessionIdFromHeader(encryptedBody);
  const knownSessions = await listKnownSessionIds(recipientUserId, me);
  const knownForPeer = knownSessions.filter(s => s.peerUserId === peerUserId);
  const peerDevices = await listDevicesForUser(peerUserId);

  // 3) Header sessionId is unknown but we DO have other sessions with this
  //    peer → either the peer rotated SPK (re-bootstrap needed) or the
  //    message comes from a peer device we have never talked to.
  const headerKnown = headerSessionId
    ? knownForPeer.some(s => s.sessionId === headerSessionId)
    : false;

  if (!headerKnown && knownForPeer.length > 0) {
    console.warn('[e2ee-session] sessionId mismatch — peer likely rotated or new device', {
      peerUserId,
      headerSessionId,
      knownSessionIds: knownForPeer.map(s => s.sessionId),
      knownPeerDevices: knownForPeer.map(s => s.peerDeviceId),
      peerDeviceCount: peerDevices.length,
    });
    return { ok: false, plaintext: null, errorCode: 'RATCHET_SESSION_UNKNOWN' };
  }

  if (peerDevices.length === 0) {
    return { ok: false, plaintext: null, errorCode: 'NO_PEER_DEVICES' };
  }

  // 4) We have the right sessionId locally, ratchet still failed → likely
  //    out-of-order delivery. Caller should enqueue for retry.
  console.warn('[e2ee-session] ratchet decrypt exhausted for known session', {
    peerUserId,
    headerSessionId,
    headerKnown,
    knownSessionsForPeer: knownForPeer.length,
  });
  return { ok: false, plaintext: null, errorCode: 'ALL_RATCHET_SESSIONS_FAILED' };
}
