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
// A send may need the sender and recipient device lists. Re-verifying both over
// the network before every message dominated warm-message latency. Keep only a
// very short RAM cache; verification remains fail-closed and is refreshed often.
const VERIFIED_DEVICE_CACHE_TTL_MS = 30_000;

interface DeviceListOptions {
  /**
   * Hot-path sends should not block on SPK network checks for every device.
   * X3DH bootstrap verifies the SPK when a new session is actually needed;
   * active Double Ratchet sessions do not need a fresh prekey fetch per send.
   */
  verifyPrekeys?: boolean;
}

interface CachedDeviceList {
  expiresAt: number;
  devices: DeviceDescriptor[];
}

const verifiedDeviceCache = new Map<string, CachedDeviceList>();
const verifiedDeviceInflight = new Map<string, Promise<DeviceDescriptor[]>>();

function cacheKey(userId: UserId, options: DeviceListOptions): string {
  return `${userId}:${options.verifyPrekeys === false ? 'no-spk' : 'spk'}`;
}

function cloneDevices(devices: DeviceDescriptor[]): DeviceDescriptor[] {
  return devices.map(device => ({ ...device }));
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

async function resolveDevicesForUser(userId: UserId, options: DeviceListOptions): Promise<DeviceDescriptor[]> {
  // Trusted (signed) list only.
  try {
    const verified = await fetchVerifiedDeviceList(userId);
    if (import.meta.env.DEV && typeof console !== 'undefined') {
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
  // sufficient authority to add a recipient device.
  if (typeof console !== 'undefined') {
    console.warn('[A1] no canonical signed device list; refusing unsigned device routing', { userId });
  }
  return [];
}

/**
 * Lot A1 — Trust gate. Returns only signed and verified device routes.
 *
 * Results are cached in RAM for ten seconds. This does not weaken the trust
 * gate: cached entries already passed canonical-root and signature checks, and
 * no unsigned fallback is introduced. The short TTL bounds device-revocation
 * staleness while removing repeated Supabase + Ed25519 work from every message.
 */
export async function listDevicesForUser(userId: UserId, options: DeviceListOptions = {}): Promise<DeviceDescriptor[]> {
  const key = cacheKey(userId, options);
  const cached = verifiedDeviceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cloneDevices(cached.devices);
  if (cached) verifiedDeviceCache.delete(key);

  const pending = verifiedDeviceInflight.get(key);
  if (pending) return cloneDevices(await pending);

  const request = resolveDevicesForUser(userId, options)
    .then(devices => {
      verifiedDeviceCache.set(key, {
        expiresAt: Date.now() + VERIFIED_DEVICE_CACHE_TTL_MS,
        devices: cloneDevices(devices),
      });
      return devices;
    })
    .finally(() => {
      verifiedDeviceInflight.delete(key);
    });

  verifiedDeviceInflight.set(key, request);
  return cloneDevices(await request);
}

/** Explicit invalidation for registration, pairing or revocation flows. */
export function invalidateVerifiedDeviceCache(userId?: UserId): void {
  if (!userId) {
    verifiedDeviceCache.clear();
    verifiedDeviceInflight.clear();
    return;
  }
  const prefix = `${userId}:`;
  for (const key of verifiedDeviceCache.keys()) {
    if (key.startsWith(prefix)) verifiedDeviceCache.delete(key);
  }
  for (const key of verifiedDeviceInflight.keys()) {
    if (key.startsWith(prefix)) verifiedDeviceInflight.delete(key);
  }
}

/**
 * List every device that should receive a copy of a message sent by
 * `senderUserId` to `recipientUserIds`. Includes ALL of the sender's own
 * devices — even the current one — so that after an iOS Safari ITP storage
 * purge the sender can recover outgoing messages from encrypted device copies.
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
