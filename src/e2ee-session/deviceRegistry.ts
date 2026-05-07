/**
 * Device registry façade — wraps the existing per-device key publishing
 * (`useDeviceRegistration` + `list_active_devices_for_user` RPC) into a
 * Sesame-style API: "give me all devices of user X".
 *
 * No new tables are created. The Supabase RPC `list_active_devices_for_user`
 * already returns the canonical device list with `device_public_key`.
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { fetchTrustedDeviceList } from '@/lib/crypto/signedDeviceList';
import type { DeviceDescriptor, UserId, DeviceId } from './types';

/** Stable device id of the current installation. Persisted in Keychain on iOS. */
export function selfDeviceId(): DeviceId {
  return getCurrentDeviceId();
}

/**
 * True when `selfDeviceId()` is still a hydration-pending fallback. Callers
 * that would otherwise pin a long-lived session (X3DH respond, ratchet
 * establish) should wait for `hydrateDeviceId()` to complete first.
 */
export function isSelfDeviceIdTemporary(): boolean {
  return isDeviceIdTemporary();
}

/**
 * Lot A1 — Trust gate.
 * Returns the set of devices we are willing to encrypt to.
 *
 * Priority:
 *  1) **Signed device list (L4)** — if `user_device_signatures` has any active
 *     entry for `userId`, ONLY signed/verified devices are accepted. This
 *     blocks the "server adds a rogue device" attack class.
 *  2) **Legacy fallback** — if no signature exists yet (pre-L4 users), fall
 *     back to the raw `list_active_devices_for_user` RPC. We log a single
 *     warning so the migration window remains visible. Once the user pairs
 *     their next companion (or rotates), the signed list becomes the source
 *     of truth and the fallback disappears for them.
 *
 * Never throws — returns [] on any error so the caller can fall back to the
 * single-device path.
 */
export async function listDevicesForUser(userId: UserId): Promise<DeviceDescriptor[]> {
  // 1) Trusted (signed) list first.
  try {
    const trusted = await fetchTrustedDeviceList(userId);
    if (trusted.length > 0) {
      return trusted
        .filter(t => !!t.devicePublicKey)
        .map(t => ({
          userId,
          deviceId: t.deviceId,
          devicePublicKey: t.devicePublicKey,
          lastSeen: undefined,
        }));
    }
  } catch (e) {
    // RPC error — fall through to legacy. Logged below at fallback boundary.
    if (typeof console !== 'undefined') {
      console.warn('[A1] signed device list fetch failed; falling back to raw RPC', e);
    }
  }

  // 2) Legacy fallback for users who haven't published any signature yet.
  try {
    const { data, error } = await supabase.rpc('list_active_devices_for_user', {
      p_user_id: userId,
    });
    if (error || !data) return [];
    if (typeof console !== 'undefined') {
      console.warn(`[A1] using LEGACY device list for ${userId} (no signed entries) — pair a device or rotate to migrate`);
    }
    return (data as Array<{ device_id: string; device_public_key: string; last_seen_at?: string; last_seen?: string }>)
      .filter(d => !!d.device_public_key)
      .map(d => ({
        userId,
        deviceId: d.device_id,
        devicePublicKey: d.device_public_key,
        lastSeen: d.last_seen_at
          ? new Date(d.last_seen_at).getTime()
          : (d.last_seen ? new Date(d.last_seen).getTime() : undefined),
      }));
  } catch {
    return [];
  }
}

/**
 * List every device that should receive a copy of a message sent by
 * `senderUserId` to `recipientUserIds`. Includes ALL of the sender's own
 * devices — even the current one — so that after an iOS Safari ITP storage
 * purge (which wipes the local plaintext mirror) the sender can still
 * recover their own outgoing messages from the encrypted device-copy
 * fan-out once their identity keys are restored.
 */
export async function listFanoutTargets(
  senderUserId: UserId,
  recipientUserIds: UserId[],
): Promise<DeviceDescriptor[]> {
  const userIds = Array.from(new Set([...recipientUserIds, senderUserId]));
  const lists = await Promise.all(userIds.map(listDevicesForUser));
  return lists.flat();
}
