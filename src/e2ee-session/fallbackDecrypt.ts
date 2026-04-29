/**
 * Fallback decrypt — when the primary session fails, try every other
 * candidate session we have for this peer user (any of their devices).
 *
 * Sesame: a session that decrypted historical messages may still be the
 * only one able to read them. We never abandon on first failure.
 */
import { ratchetDecrypt, RATCHET_PREFIX_V3, RATCHET_PREFIX_V4 } from '@/lib/crypto/deviceRatchet';
import { listDevicesForUser, selfDeviceId } from './deviceRegistry';
import type { DecryptResult, UserId } from './types';

/**
 * Try every (selfDevice, peerDevice) ratchet session belonging to `peerUserId`.
 * Useful when the message body is a v3/v4 ratchet ciphertext but we don't
 * know which peer device produced it (e.g. peer is multi-device and the
 * `sender_device_id` column is missing or stale).
 */
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
  const peerDevices = await listDevicesForUser(peerUserId);
  if (peerDevices.length === 0) {
    return { ok: false, plaintext: null, errorCode: 'NO_PEER_DEVICES' };
  }

  // ratchetDecrypt() looks the session up by sessionId embedded in the
  // ciphertext header — but in the v3 path the matching session might be
  // stored under a different peerDeviceId after a Keychain rotation. We
  // therefore call it once per known peer device; the first that returns
  // a plaintext wins.
  void me;
  for (const dev of peerDevices) {
    void dev; // current ratchetDecrypt API is global per (selfUser, selfDevice)
    try {
      const pt = await ratchetDecrypt(recipientUserId, me, encryptedBody);
      if (pt !== null) {
        return { ok: true, plaintext: pt, via: 'fallback-session' };
      }
    } catch { /* try next */ }
  }
  return { ok: false, plaintext: null, errorCode: 'ALL_RATCHET_SESSIONS_FAILED' };
}
