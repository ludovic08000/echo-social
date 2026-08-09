/**
 * Canonical per-user device registry.
 *
 * Server routing eligibility comes only from list_active_devices_for_user:
 * approved + active + account-bound + route-ready + valid SPK. Each returned
 * route is then cryptographically verified against the account identity and
 * the device authorization before it is exposed to X3DH/fanout.
 */
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { ensureApprovedDeviceTrust } from '@/lib/crypto/deviceLinkTrust';
import { peekDeviceSignedPrekey } from '@/lib/crypto/x3dh';
import type { DeviceDescriptor, UserId, DeviceId } from './types';

const VERIFIED_DEVICE_CACHE_TTL_MS = 30_000;

interface DeviceListOptions {
  verifyPrekeys?: boolean;
}

interface CachedDeviceList {
  expiresAt: number;
  devices: DeviceDescriptor[];
}

type CanonicalRouteRow = {
  device_id: string;
  device_public_key: string;
  platform: string | null;
  last_seen_at: string | null;
};

const verifiedDeviceCache = new Map<string, CachedDeviceList>();
const verifiedDeviceInflight = new Map<string, Promise<DeviceDescriptor[]>>();
let verifiedDeviceGeneration = 0;

function cacheKey(userId: UserId, options: DeviceListOptions): string {
  return `${userId}:${options.verifyPrekeys === false ? 'no-spk' : 'spk'}`;
}

function cloneDevices(devices: DeviceDescriptor[]): DeviceDescriptor[] {
  return devices.map((device) => ({ ...device }));
}

export function selfDeviceId(): DeviceId {
  return getCurrentDeviceId();
}

export function isSelfDeviceIdTemporary(): boolean {
  return isDeviceIdTemporary();
}

function normalizeLastSeen(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const ts = new Date(raw).getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

async function readCanonicalRoutes(userId: UserId): Promise<CanonicalRouteRow[]> {
  const { data, error } = await (supabase as any).rpc('list_active_devices_for_user', {
    p_user_id: userId,
  });
  if (error) throw new Error('E2EE_DEVICE_REGISTRY_UNAVAILABLE');
  return (data ?? []) as CanonicalRouteRow[];
}

async function verifyCanonicalRoutes(
  userId: UserId,
  rows: CanonicalRouteRow[],
  options: DeviceListOptions,
): Promise<DeviceDescriptor[]> {
  const deduped = new Map<string, CanonicalRouteRow>();
  for (const row of rows) {
    if (!row.device_id || !row.device_public_key) continue;
    const previous = deduped.get(row.device_id);
    const currentTs = normalizeLastSeen(row.last_seen_at) ?? 0;
    const previousTs = previous ? (normalizeLastSeen(previous.last_seen_at) ?? 0) : -1;
    if (!previous || currentTs > previousTs) deduped.set(row.device_id, row);
  }

  const verified = await Promise.all(Array.from(deduped.values()).map(async (row) => {
    try {
      await ensureApprovedDeviceTrust(userId, row.device_id);
      if (options.verifyPrekeys !== false) {
        const spk = await peekDeviceSignedPrekey(userId, row.device_id);
        if (!spk) return null;
      }
      return {
        userId,
        deviceId: row.device_id,
        devicePublicKey: row.device_public_key,
        lastSeen: normalizeLastSeen(row.last_seen_at),
      } satisfies DeviceDescriptor;
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('[DEVTRUST] rejected canonical device route', {
          userId: String(userId).slice(0, 8),
          deviceId: row.device_id.slice(0, 12),
          reason: error instanceof Error ? error.message : 'UNKNOWN',
        });
      }
      return null;
    }
  }));

  return verified.filter((value): value is DeviceDescriptor => value !== null);
}

async function resolveDevicesForUser(
  userId: UserId,
  options: DeviceListOptions,
): Promise<DeviceDescriptor[]> {
  const rows = await readCanonicalRoutes(userId);
  if (rows.length === 0) return [];

  const devices = await verifyCanonicalRoutes(userId, rows, options);
  if (rows.length > 0 && devices.length === 0) {
    throw new Error('E2EE_DEVICE_REGISTRY_INVALID');
  }
  return devices;
}

export async function listDevicesForUser(
  userId: UserId,
  options: DeviceListOptions = {},
): Promise<DeviceDescriptor[]> {
  const key = cacheKey(userId, options);
  const cached = verifiedDeviceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cloneDevices(cached.devices);
  if (cached) verifiedDeviceCache.delete(key);

  const pending = verifiedDeviceInflight.get(key);
  if (pending) return cloneDevices(await pending);

  const generation = verifiedDeviceGeneration;
  const request = resolveDevicesForUser(userId, options)
    .then((devices) => {
      if (generation === verifiedDeviceGeneration) {
        verifiedDeviceCache.set(key, {
          expiresAt: Date.now() + VERIFIED_DEVICE_CACHE_TTL_MS,
          devices: cloneDevices(devices),
        });
      }
      return devices;
    })
    .finally(() => {
      verifiedDeviceInflight.delete(key);
    });

  verifiedDeviceInflight.set(key, request);
  return cloneDevices(await request);
}

export function invalidateVerifiedDeviceCache(userId?: UserId): void {
  verifiedDeviceGeneration += 1;
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

export async function listFanoutTargets(
  senderUserId: UserId,
  recipientUserIds: UserId[],
  options: DeviceListOptions = {},
): Promise<DeviceDescriptor[]> {
  const userIds = Array.from(new Set([...recipientUserIds, senderUserId]));
  const lists = await Promise.all(userIds.map((userId) => listDevicesForUser(userId, options)));
  const unroutable = userIds.filter((_, index) => lists[index].length === 0);
  if (unroutable.length > 0) {
    throw new Error(`E2EE_PARTICIPANT_ROUTE_UNAVAILABLE:${unroutable.join(',')}`);
  }
  return lists.flat();
}
