import { supabase } from '@/integrations/supabase/client';
import {
  invalidateVerifiedDeviceCache,
  listFanoutTargets,
} from '@/e2ee-session/deviceRegistry';
import type { DeviceDescriptor } from '@/e2ee-session/types';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';

const ROUTE_TTL_MS = 20_000;

type RouteCacheEntry = {
  expiresAt: number;
  targets: DeviceDescriptor[];
};

type RouteLoader = () => Promise<DeviceDescriptor[]>;

const routeCache = new Map<string, RouteCacheEntry>();
const inflightRoutes = new Map<string, Promise<DeviceDescriptor[]>>();

function routeKey(conversationId: string, senderUserId: string, senderDeviceId: string): string {
  return `${conversationId}:${senderUserId}:${senderDeviceId}`;
}

function routePrefix(conversationId: string, senderUserId: string): string {
  return `${conversationId}:${senderUserId}:`;
}

async function resolveCachedRoute(
  key: string,
  loader: RouteLoader,
  now = Date.now(),
): Promise<DeviceDescriptor[]> {
  const cached = routeCache.get(key);
  if (cached && cached.expiresAt > now) return cached.targets;
  if (cached) routeCache.delete(key);

  const active = inflightRoutes.get(key);
  if (active) return active;

  const promise = loader()
    .then((targets) => {
      // The cache is a latency optimisation only. The send RPC remains the
      // authoritative Sesame device-list validator and may force one refresh.
      routeCache.set(key, {
        expiresAt: now + ROUTE_TTL_MS,
        targets,
      });
      return targets;
    })
    .finally(() => {
      if (inflightRoutes.get(key) === promise) inflightRoutes.delete(key);
    });

  inflightRoutes.set(key, promise);
  return promise;
}

async function loadFanoutRoute(
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
): Promise<DeviceDescriptor[]> {
  const { data: participants, error } = await supabase
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', conversationId);

  if (error) throw error;

  const userIds = Array.from(new Set((participants ?? [])
    .map((participant) => participant.user_id)
    .filter((userId): userId is string => Boolean(userId))));

  if (userIds.length === 0) return [];

  const targets = await listFanoutTargets(senderUserId, userIds, { verifyPrekeys: false });
  return targets.filter((device) =>
    !(device.userId === senderUserId && device.deviceId === senderDeviceId),
  );
}

export async function resolveFanoutRoute(
  conversationId: string,
  senderUserId: string,
): Promise<DeviceDescriptor[]> {
  if (!conversationId || !senderUserId || isDeviceIdTemporary()) return [];
  const senderDeviceId = getCurrentDeviceId();
  const key = routeKey(conversationId, senderUserId, senderDeviceId);
  return resolveCachedRoute(
    key,
    () => loadFanoutRoute(conversationId, senderUserId, senderDeviceId),
  );
}

/**
 * Discards every cached/in-flight route for a conversation and sender. Sesame
 * stale-list retries call this before rebuilding copies exactly once.
 */
export function invalidateFanoutRoute(
  conversationId: string,
  senderUserId: string,
): void {
  // The route cache is built from the separately cached signed device lists.
  // Clear both layers; otherwise a stale-route retry rebuilds the same route.
  invalidateVerifiedDeviceCache();
  const prefix = routePrefix(conversationId, senderUserId);
  for (const key of routeCache.keys()) {
    if (key.startsWith(prefix)) routeCache.delete(key);
  }
  for (const key of inflightRoutes.keys()) {
    if (key.startsWith(prefix)) inflightRoutes.delete(key);
  }
}

/**
 * Preloads participants and verified device descriptors only. It never fetches
 * prekeys, claims an OPK, creates X3DH state or advances a ratchet.
 */
export async function warmFanoutRoute(
  conversationId: string,
  senderUserId: string,
): Promise<void> {
  await resolveFanoutRoute(conversationId, senderUserId);
}

export const __test__ = {
  ttlMs: ROUTE_TTL_MS,
  reset(): void {
    routeCache.clear();
    inflightRoutes.clear();
  },
  size(): number {
    return routeCache.size;
  },
  resolveCachedRoute,
  invalidatePrefix(prefix: string): void {
    for (const key of routeCache.keys()) {
      if (key.startsWith(prefix)) routeCache.delete(key);
    }
    for (const key of inflightRoutes.keys()) {
      if (key.startsWith(prefix)) inflightRoutes.delete(key);
    }
  },
};
