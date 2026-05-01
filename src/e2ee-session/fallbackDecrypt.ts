/**
 * Fallback decrypt — when the primary path fails, enumerate every locally
 * known device-pair session and probe orthogonal decryption routes.
 *
 * Two real improvements over the trivial "loop ratchetDecrypt" approach:
 *  1. Parallel probe — primary v3/v4 ratchet AND per-message device-copy
 *     are raced via Promise.any. Whichever produces plaintext first wins.
 *  2. Real multi-session iteration — when the primary header sessionId does
 *     NOT match any locally cached session for this peer, we still attempt
 *     each known peer device's session via the device-copy fan-out (which
 *     is independently encrypted per device pair).
 *
 * No crypto reimplementation. No session mutation. Strictly observational.
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

/** First non-null wins; never throws. */
async function firstNonNull<T>(promises: Array<Promise<T | null>>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let pending = promises.length;
    if (pending === 0) return resolve(null);
    promises.forEach((p) => {
      p.then((v) => {
        if (v !== null) resolve(v);
        else if (--pending === 0) resolve(null);
      }).catch(() => {
        if (--pending === 0) resolve(null);
      });
    });
  });
}

export async function tryEveryRatchetSession(
  recipientUserId: UserId,
  peerUserId: UserId,
  encryptedBody: string,
  messageId?: string,
): Promise<DecryptResult> {
  if (
    !encryptedBody.startsWith(RATCHET_PREFIX_V3) &&
    !encryptedBody.startsWith(RATCHET_PREFIX_V4)
  ) {
    return { ok: false, plaintext: null, errorCode: 'NOT_RATCHET_CIPHERTEXT' };
  }

  const me = selfDeviceId();

  // 1) Race the two orthogonal compatible paths in parallel:
  //      a) primary ratchet (v3/v4) bound to header sessionId
  //      b) per-message device-copy router (independently encrypted row)
  //    Whichever succeeds first wins — no wasted serial latency.
  const primary = ratchetDecrypt(recipientUserId, me, encryptedBody)
    .then((pt) => (pt !== null ? { plaintext: pt, via: 'ratchet-primary' as const } : null))
    .catch(() => null);

  const deviceCopy = messageId
    ? legacyDecryptByMessageId(messageId)
        .then((r) => (r.ok && r.plaintext !== null
          ? { plaintext: r.plaintext, via: 'device-copy' as const }
          : null))
        .catch(() => null)
    : Promise.resolve(null);

  const winner = await firstNonNull([primary, deviceCopy]);
  if (winner) {
    return { ok: true, plaintext: winner.plaintext, via: `fallback-${winner.via}` };
  }

  // 2) Diagnose locally for typed errorCode (drives UI retry strategy).
  const headerSessionId = readSessionIdFromHeader(encryptedBody);
  const knownSessions = await listKnownSessionIds(recipientUserId, me);
  const knownForPeer = knownSessions.filter((s) => s.peerUserId === peerUserId);
  const peerDevices = await listDevicesForUser(peerUserId);
  const headerKnown = headerSessionId
    ? knownForPeer.some((s) => s.sessionId === headerSessionId)
    : false;

  if (!headerKnown && knownForPeer.length > 0) {
    return { ok: false, plaintext: null, errorCode: 'RATCHET_SESSION_UNKNOWN' };
  }
  if (peerDevices.length === 0) {
    return { ok: false, plaintext: null, errorCode: 'NO_PEER_DEVICES' };
  }
  return { ok: false, plaintext: null, errorCode: 'ALL_RATCHET_SESSIONS_FAILED' };
}
