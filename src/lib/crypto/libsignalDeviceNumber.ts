import { supabase } from '@/integrations/supabase/client';
import { runDeviceRpcWithTimeout } from '@/lib/api/deviceRpcTimeout';

const DEVICE_NUMBER_CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
const DEVICE_NUMBER_WARM_CONCURRENCY = 4;

type RpcResult<T> = {
  data: T;
  error: { message: string } | null;
};

type DeviceNumberCacheEntry = {
  expiresAt: number;
  value: number;
};

export type LibsignalDeviceReference = {
  userId: string;
  deviceId: string;
};

const cache = new Map<string, DeviceNumberCacheEntry>();
const inflight = new Map<string, Promise<number>>();

function cacheKey(userId: string, deviceId: string): string {
  return JSON.stringify([userId, deviceId]);
}

function assertDeviceNumber(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 127) {
    throw new Error('AEGIS_LIBSIGNAL_DEVICE_NUMBER_UNAVAILABLE');
  }
  return number;
}

async function fetchDeviceNumber(userId: string, deviceId: string): Promise<number> {
  const { data, error } = await runDeviceRpcWithTimeout<RpcResult<number>>(
    'AEGIS_LIBSIGNAL_DEVICE_NUMBER_UNAVAILABLE',
    (signal) => (supabase as any)
      .rpc('get_libsignal_device_number', {
        p_user_id: userId,
        p_device_id: deviceId,
      })
      .abortSignal(signal),
  );
  if (error) throw new Error('AEGIS_LIBSIGNAL_DEVICE_NUMBER_UNAVAILABLE');
  return assertDeviceNumber(data);
}

/**
 * Invariant cryptographique : seul l'identifiant numérique public et immuable
 * d'une installation est caché. Le store, les sessions et le ratchet restent
 * relus et scellés par le bridge Libsignal à chaque mutation.
 */
export function getLibsignalDeviceNumber(
  userId: string,
  deviceId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<number> {
  if (!userId || !deviceId) {
    return Promise.reject(new Error('AEGIS_LIBSIGNAL_DEVICE_NUMBER_INPUT_INVALID'));
  }

  const key = cacheKey(userId, deviceId);
  if (options.forceRefresh) cache.delete(key);

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  if (cached) cache.delete(key);

  const active = inflight.get(key);
  if (active) return active;

  const work = fetchDeviceNumber(userId, deviceId)
    .then((value) => {
      cache.set(key, {
        value,
        expiresAt: Date.now() + DEVICE_NUMBER_CACHE_TTL_MS,
      });
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === work) inflight.delete(key);
    });

  inflight.set(key, work);
  return work;
}

/** Précharge les routes publiques avec une concurrence bornée sur mobile. */
export async function warmLibsignalDeviceNumbers(
  devices: readonly LibsignalDeviceReference[],
): Promise<void> {
  const unique = Array.from(new Map(
    devices
      .filter((device) => Boolean(device.userId && device.deviceId))
      .map((device) => [cacheKey(device.userId, device.deviceId), device]),
  ).values());

  let next = 0;
  const workers = Array.from(
    { length: Math.min(DEVICE_NUMBER_WARM_CONCURRENCY, unique.length) },
    async () => {
      while (next < unique.length) {
        const device = unique[next++];
        await getLibsignalDeviceNumber(device.userId, device.deviceId);
      }
    },
  );
  await Promise.all(workers);
}

export function invalidateLibsignalDeviceNumberCache(): void {
  cache.clear();
  inflight.clear();
}

if (typeof window !== 'undefined') {
  window.addEventListener('forsure:logout', invalidateLibsignalDeviceNumberCache);
}

export const __libsignalDeviceNumberTest = {
  ttlMs: DEVICE_NUMBER_CACHE_TTL_MS,
  reset: invalidateLibsignalDeviceNumberCache,
  size: () => cache.size,
};
