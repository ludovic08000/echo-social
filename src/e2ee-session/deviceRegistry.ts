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
import { fetchVerifiedDeviceList } from '@/lib/crypto/signedDeviceList';
import { peekDeviceSignedPrekey } from '@/lib/crypto/x3dh';
import type { DeviceDescriptor, UserId, DeviceId } from './types';

const MAX_DEVICE_STALE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

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

function normalizeLastSeen(raw?: string): number | undefined {
  if (!raw) return undefined;
  const ts = new Date(raw).getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

function isDeviceTooOld(lastSeen?: number): boolean {
  if (!lastSeen) return false;
  return (Date.now() - lastSeen) > MAX_DEVICE_STALE_MS;
}

async function hygieneFilterDevices(devices: DeviceDescriptor[]): Promise<DeviceDescriptor[]> {
  const deduped = new Map<string, DeviceDescriptor>();

  for (const device of devices) {
    if (!device.deviceId || !device.devicePublicKey) continue;

    const previous = deduped.get(device.deviceId);
    if (!previous || (device.lastSeen ?? 0) > (previous.lastSeen ?? 0)) {
      deduped.set(device.deviceId, device);
    }
  }

  const candidates = Array.from(deduped.values())
    .filter(device => !isDeviceTooOld(device.lastSeen));

  const verified = await Promise.all(candidates.map(async (device) => {
    try {
      const spk = await peekDeviceSignedPrekey(device.userId, device.deviceId);
      if (!spk) {
        console.warn('[A1] skipping device without valid signed prekey', {
          userId: device.userId,
          deviceId: device.deviceId,
        });
        return null;
      }
      return device;
    } catch {
      return null;
    }
  }));

  return verified.filter(Boolean) as DeviceDescriptor[];
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
    const verified = await fetchVerifiedDeviceList(userId);
    if (verified.signedListPresent) {
      if (verified.trusted.length === 0 && typeof console !== 'undefined') {
        console.warn('[A1] signed device list present but no device verified; refusing raw fallback', {
          userId,
          rejected: verified.verifications.length,
        });
      }
      return hygieneFilterDevices(
        verified.trusted
          .filter(t => !!t.devicePublicKey)
          .map(t => ({
            userId,
            deviceId: t.deviceId,
            devicePublicKey: t.devicePublicKey,
            lastSeen: undefined,
          })),
      );
    }
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.warn('[A1] signed device list fetch failed; refusing raw fallback', e);
    }
    return [];
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

    const mapped = (data as Array<{ device_id: string; device_public_key: string; last_seen_at?: string; last_seen?: string }>)
      .filter(d => !!d.device_public_key)
      .map(d => ({
        userId,
        deviceId: d.device_id,
        devicePublicKey: d.device_public_key,
        lastSeen: normalizeLastSeen(d.last_seen_at ?? d.last_seen),
      }));

    return hygieneFilterDevices(mapped);
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
