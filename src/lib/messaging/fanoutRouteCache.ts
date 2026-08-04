import { supabase } from '@/integrations/supabase/client';
import {
  invalidateVerifiedDeviceCache,
  listFanoutTargets,
} from '@/e2ee-session/deviceRegistry';
import type { DeviceDescriptor } from '@/e2ee-session/types';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { resolveConversationRoute } from '@/lib/messaging/aegisRouteResolver';


const ROUTE_TTL_MS = 20_000;

type RouteCacheEntry = {
  expiresAt: number;
  snapshot: FanoutRouteSnapshot;
};

export type FanoutRouteSnapshot = {
  version: string;
  targets: DeviceDescriptor[];
};

type RouteLoader = () => Promise<FanoutRouteSnapshot>;

const routeCache = new Map<string, RouteCacheEntry>();
const inflightRoutes = new Map<string, Promise<FanoutRouteSnapshot>>();
let routeGeneration = 0;

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
): Promise<FanoutRouteSnapshot> {
  const cached = routeCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { version: cached.snapshot.version, targets: [...cached.snapshot.targets] };
  }
  if (cached) routeCache.delete(key);

  const active = inflightRoutes.get(key);
  if (active) return active;

  const generation = routeGeneration;
  const promise = loader()
    .then((snapshot) => {
      // The cache is a latency optimisation only. The send RPC remains the
      // authoritative Aegis device-list validator and may force one refresh.
      if (generation === routeGeneration) {
        routeCache.set(key, {
          expiresAt: now + ROUTE_TTL_MS,
          snapshot,
        });
      }
      return snapshot;
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

async function readConversationRouteVersion(conversationId: string): Promise<string> {
  const { data, error } = await supabase.rpc('get_aegis_conversation_route_version', {
    p_conversation_id: conversationId,
  });
  if (error || typeof data !== 'string' || data.length < 8) {
    throw new Error(error?.message || 'E2EE_ROUTE_VERSION_UNAVAILABLE');
  }
  return data;
}

async function loadStableFanoutRoute(
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
): Promise<FanoutRouteSnapshot> {
  // Chemin principal : module de routage serveur, version + appareils lus dans
  // le même instantané (aucune dérive possible entre les deux lectures).
  try {
    const resolved = await resolveConversationRoute(conversationId, senderUserId, senderDeviceId);
    if (resolved.unroutableUserIds.length > 0) {
      throw new Error(`E2EE_PARTICIPANT_ROUTE_UNAVAILABLE:${resolved.unroutableUserIds.join(',')}`);
    }
    return { version: resolved.version, targets: resolved.targets };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith('E2EE_PARTICIPANT_ROUTE_UNAVAILABLE')) throw e;
    if (typeof console !== 'undefined') {
      console.warn('[ROUTE] server route module unavailable; falling back to per-user resolution', message);
    }
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await readConversationRouteVersion(conversationId);
    const targets = await loadFanoutRoute(conversationId, senderUserId, senderDeviceId);
    const after = await readConversationRouteVersion(conversationId);
    if (before === after) return { version: after, targets };
    invalidateVerifiedDeviceCache();
  }

  throw new Error('E2EE_DEVICE_LIST_STALE');
}

export async function resolveFanoutRouteSnapshot(
  conversationId: string,
  senderUserId: string,
): Promise<FanoutRouteSnapshot> {
  if (!conversationId || !senderUserId || isDeviceIdTemporary()) {
    return { version: '', targets: [] };
  }
  const senderDeviceId = getCurrentDeviceId();
  const key = routeKey(conversationId, senderUserId, senderDeviceId);
  return resolveCachedRoute(
    key,
    () => loadStableFanoutRoute(conversationId, senderUserId, senderDeviceId),
  );
}

export async function resolveFanoutRoute(
  conversationId: string,
  senderUserId: string,
): Promise<DeviceDescriptor[]> {
  return (await resolveFanoutRouteSnapshot(conversationId, senderUserId)).targets;
}

/**
 * Discards every cached/in-flight route for a conversation and sender. Aegis
 * stale-list retries call this before rebuilding copies exactly once.
 */
export function invalidateFanoutRoute(
  conversationId: string,
  senderUserId: string,
): void {
  // The route cache is built from the separately cached signed device lists.
  // Clear both layers; otherwise a stale-route retry rebuilds the same route.
  invalidateVerifiedDeviceCache();
  routeGeneration += 1;
  const prefix = routePrefix(conversationId, senderUserId);
  for (const key of routeCache.keys()) {
    if (key.startsWith(prefix)) routeCache.delete(key);
  }
  for (const key of inflightRoutes.keys()) {
    if (key.startsWith(prefix)) inflightRoutes.delete(key);
  }
}

/** Clear every speculative route after a device/root/signature transition. */
export function invalidateAllFanoutRoutes(): void {
  invalidateVerifiedDeviceCache();
  routeGeneration += 1;
  routeCache.clear();
  inflightRoutes.clear();
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
    routeGeneration += 1;
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
