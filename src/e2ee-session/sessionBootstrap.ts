/**
 * Session bootstrap — thin wrapper around X3DH initiation per device.
 *
 * Handshake is delegated to `multiDeviceFanout.x3dhWrapForDevice` (which
 * also seeds the ratchet state on success). This file exists to give the
 * Sesame layer a clean entry point and to centralise the rule:
 *   "never block message delivery if a bootstrap attempt fails — let the
 *    fallback chain take over."
 */
import { fetchPrekeyBundleForDevice } from '@/lib/crypto/x3dh';
import type { DeviceDescriptor, UserId } from './types';

/**
 * Probe whether a peer device has an X3DH bundle published.
 * Used by the message router to decide between bootstrap and legacy wrap.
 */
export async function hasPrekeyBundle(peer: DeviceDescriptor): Promise<boolean> {
  try {
    const bundle = await fetchPrekeyBundleForDevice(peer.userId, peer.deviceId);
    return !!bundle?.signedPrekey;
  } catch {
    return false;
  }
}
