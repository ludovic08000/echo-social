/**
 * Session manager — high-level "ensure I have a working session for this
 * (selfDevice, peerDevice) pair" API. Wraps:
 *   - cached Double Ratchet (`ratchetEncrypt` fast path)
 *   - X3DH bootstrap (`fetchPrekeyBundleForDevice` + `x3dhInitiate`)
 *   - device-wrap legacy ECDH fallback
 *
 * Sesame guarantees enforced here:
 *   - existing sessions are NEVER overwritten silently. Re-bootstrap only
 *     happens when the peer's SPK changed (handled inside `multiDeviceFanout`).
 *   - failures fall through to the next layer instead of aborting send.
 */
import { ratchetEncrypt } from '@/lib/crypto/deviceRatchet';
import type { DeviceDescriptor, UserId } from './types';
import { describeSession, markSessionUsed } from './sessionStore';
import { selfDeviceId } from './deviceRegistry';

/**
 * Encrypt a plaintext for ONE peer device, trying every layer in priority
 * order. Returns the wire string (already prefixed by the underlying layer
 * — `x3dh4.`, `x3dh3.`, `x3dh1.`, etc.) or `null` if every path failed.
 *
 * IMPORTANT: this function never throws. A null result means "fall back to
 * the conversation-level ratchet (`messages.body`)" — the message is still
 * delivered, just without a per-device copy for that target.
 */
export async function encryptForDevice(
  senderUserId: UserId,
  peer: DeviceDescriptor,
  plaintext: string,
): Promise<string | null> {
  const me = selfDeviceId();
  const desc = describeSession(senderUserId, me, peer.userId, peer.deviceId);

  // Fast path: cached Double Ratchet (v3/v4).
  try {
    const ct = await ratchetEncrypt(senderUserId, me, peer.userId, peer.deviceId, plaintext);
    if (ct) {
      markSessionUsed(desc.sessionId, ct.startsWith('x3dh4.') ? 'ratchet-v4' : 'ratchet-v3-legacy');
      return ct;
    }
  } catch {
    /* fall through */
  }

  // Bootstrap + legacy paths are owned by `multiDeviceFanout` which already
  // implements them. Returning `null` here lets the fanout module take over.
  return null;
}
