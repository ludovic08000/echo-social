import { supabase } from '@/integrations/supabase/client';
import {
  fetchPrekeyBundleForDevice,
  type X3DHPrekeyBundle,
} from './x3dh';

const DEVICE_BUNDLE_TIMEOUT_MS = 12_000;
const MAX_DEVICE_BUNDLE_CANDIDATES = 5;
const MAX_DEVICE_STALE_MS = 90 * 24 * 60 * 60 * 1000;

type ActiveDeviceRow = {
  device_id?: string | null;
  last_seen_at?: string | null;
};

function isFresh(lastSeenAt?: string | null): boolean {
  if (!lastSeenAt) return true;
  const ts = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts <= MAX_DEVICE_STALE_MS;
}

function uniqueFreshDeviceIds(rows: ActiveDeviceRow[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows || []) {
    if (!isFresh(row.last_seen_at)) continue;
    const deviceId = typeof row.device_id === 'string' ? row.device_id.trim() : '';
    if (!deviceId || seen.has(deviceId)) continue;
    seen.add(deviceId);
    out.push(deviceId);
    if (out.length >= MAX_DEVICE_BUNDLE_CANDIDATES) break;
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function fetchActiveDeviceIds(peerUserId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('user_devices' as any)
    .select('device_id,last_seen_at,revoked_at')
    .eq('user_id', peerUserId)
    .is('revoked_at', null)
    .order('last_seen_at', { ascending: false })
    .limit(MAX_DEVICE_BUNDLE_CANDIDATES);

  if (error) {
    console.warn('[X3DH][ROUTE] active device lookup failed', { peerUserId, error: error.message });
    return [];
  }

  return uniqueFreshDeviceIds(data as ActiveDeviceRow[]);
}

async function notifyDeviceBundleProblem(peerUserId: string, peerDeviceId: string, reason: string): Promise<void> {
  try {
    window.dispatchEvent(new CustomEvent('forsure:e2ee-peer-device-bundle-problem', {
      detail: { peerUserId, peerDeviceId, reason },
    }));
  } catch {}
}

export async function fetchPrekeyBundle(peerUserId: string): Promise<X3DHPrekeyBundle | null> {
  const activeDeviceIds = await fetchActiveDeviceIds(peerUserId);

  if (activeDeviceIds.length > 0) {
    for (const peerDeviceId of activeDeviceIds) {
      try {
        const bundle = await withTimeout(
          fetchPrekeyBundleForDevice(peerUserId, peerDeviceId),
          DEVICE_BUNDLE_TIMEOUT_MS,
          'device_prekey_bundle',
        );

        if (bundle) {
          console.info('[X3DH][ROUTE] device bundle selected', {
            peerUserId,
            peerDeviceId,
            activeDeviceCount: activeDeviceIds.length,
            spkId: bundle.signedPrekeyId,
          });
          return bundle;
        }

        await notifyDeviceBundleProblem(peerUserId, peerDeviceId, 'device_prekey_bundle_missing');
        console.warn('[X3DH][ROUTE] active device has no usable bundle', { peerUserId, peerDeviceId });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await notifyDeviceBundleProblem(peerUserId, peerDeviceId, reason);
        console.warn('[X3DH][ROUTE] active device bundle failed', { peerUserId, peerDeviceId, reason });
      }
    }

    console.warn('[X3DH][ROUTE] active devices exist but no device bundle is usable', {
      peerUserId,
      activeDeviceCount: activeDeviceIds.length,
    });
    return null;
  }

  console.warn('[X3DH][ROUTE] no authenticated Aegis device is available', { peerUserId });
  return null;
}
