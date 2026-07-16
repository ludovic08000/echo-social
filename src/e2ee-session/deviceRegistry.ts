/**
 * Device registry façade — wraps the existing per-device key publishing
 * (`useDeviceRegistration` + `list_active_devices_for_user` RPC) into a
 * Sesame-style API: "give me all devices of user X".
 *
 * No new tables are created. The Supabase RPC `list_active_devices_for_user`
 * already returns the canonical device list with `device_public_key`.
 */
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { fetchVerifiedDeviceList } from '@/lib/crypto/signedDeviceList';
import { peekDeviceSignedPrekey } from '@/lib/crypto/x3dh';
import type { DeviceDescriptor, UserId, DeviceId } from './types';

const MAX_DEVICE_STALE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

interface DeviceListOptions {
  /**
   * Hot-path sends should not block on SPK network checks for every device.
   * X3DH bootstrap verifies the SPK when a new session is actually needed;
   * active Double Ratchet sessions do not need a fresh prekey fetch per send.
   */
  verifyPrekeys?: boolean;
}

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

async function hygieneFilterDevices(devices: DeviceDescriptor[], options: DeviceListOptions = {}): Promise<DeviceDescriptor[]> {
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

  if (options.verifyPrekeys === false) return candidates;

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
export async function listDevicesForUser(userId: UserId, options: DeviceListOptions = {}): Promise<DeviceDescriptor[]> {
  // 1) Trusted (signed) list first.
  try {
    const verified = await fetchVerifiedDeviceList(userId);
    if (typeof console !== 'undefined') {
      // [DIAG] Full visibility on the trust gate: which devices are accepted and
      // WHY the others are rejected. A second device rejected as NO_SIGNATURE is
      // the signature of the broken multi-device path (companion never signed).
      const reasons: Record<string, number> = {};
      for (const v of verified.verifications) {
        const k = `${v.reason ?? '?'}${v.ok ? '' : '!'}`;
        reasons[k] = (reasons[k] ?? 0) + 1;
      }
      console.info('[DEVTRUST] device list resolved', {
        userId: String(userId).slice(0, 8),
        signedListPresent: verified.signedListPresent,
        total: verified.verifications.length,
        trusted: verified.trusted.length,
        trustedIds: verified.trusted.map(t => String(t.deviceId).slice(0, 8)),
        reasons,
      });
    }
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
        options,
      );
    }
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.warn('[A1] signed device list fetch failed; refusing raw fallback', e);
    }
    return [];
  }

  // Signal-style trust is fail-closed: an unsigned server device list is not
  // sufficient authority to add a recipient device. Registration must publish
  // the canonical primary root and signed companions before messaging starts.
  if (typeof console !== 'undefined') {
    console.warn('[A1] no canonical signed device list; refusing unsigned device routing', { userId });
  }
  return [];
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
  options: DeviceListOptions = {},
): Promise<DeviceDescriptor[]> {
  const userIds = Array.from(new Set([...recipientUserIds, senderUserId]));
  const lists = await Promise.all(userIds.map(userId => listDevicesForUser(userId, options)));
  return lists.flat();
}
