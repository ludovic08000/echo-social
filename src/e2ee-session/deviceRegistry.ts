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
 * List every active device of `userId`. Never throws — returns [] on RPC error
 * so the caller can fall back to the single-device path.
 */
export async function listDevicesForUser(userId: UserId): Promise<DeviceDescriptor[]> {
  try {
    const { data, error } = await supabase.rpc('list_active_devices_for_user', {
      p_user_id: userId,
    });
    if (error || !data) return [];
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
 * `senderUserId` to `recipientUserIds`. Excludes the sender's CURRENT device
 * (it already keeps the plaintext locally) but INCLUDES the sender's other
 * devices so they sync the conversation.
 */
export async function listFanoutTargets(
  senderUserId: UserId,
  recipientUserIds: UserId[],
): Promise<DeviceDescriptor[]> {
  const me = selfDeviceId();
  const userIds = Array.from(new Set([...recipientUserIds, senderUserId]));
  const lists = await Promise.all(userIds.map(listDevicesForUser));
  return lists
    .flat()
    .filter(d => !(d.userId === senderUserId && d.deviceId === me));
}
