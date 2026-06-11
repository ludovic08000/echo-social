import { nativeSet, nativeGetSync } from '@/lib/nativeStore';
import { secureSet } from '@/lib/secureStore';

const DEVICE_ID_KEY = 'forsure-device-id-v1';
const INVALID_CACHE_KEY = 'forsure:invalid-device-spk-cache:v1';
const CLEAN_VERSION_KEY = 'forsure:e2ee-clean-startup:v1';

const INVALID_DEVICE_IDS = [
  '6508eb47a200893f49720fe84b9290b3',
  '9da8c742a4fe81d1d9ce6c0ffb4e055b',
  '75e575fcbfaa8066bcbc9105fc5f4ac8',
  'c6601674b0f700f28c9f2956774eca97',
  '52adb13ff236ae5c833c9d9049c0df71',
  'b166de502d729356dcbd6c0b5b1a39b0',
  '49cfdeab59355de3051925b4f09fba75',
  '92585130870cedf210af1019379dbc61',
  '450c0cd9af35813c8a99ec5bc0f39ab8',
];

const INVALID_SET = new Set(INVALID_DEVICE_IDS);

function generateDeviceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getStoredDeviceIds(): string[] {
  const ids: string[] = [];
  try { const v = localStorage.getItem(DEVICE_ID_KEY); if (v) ids.push(v); } catch {}
  try { const v = sessionStorage.getItem(DEVICE_ID_KEY); if (v) ids.push(v); } catch {}
  try { const v = nativeGetSync(DEVICE_ID_KEY); if (v) ids.push(v); } catch {}
  return ids;
}

function rememberInvalidDevices(): void {
  try {
    const existing = JSON.parse(localStorage.getItem(INVALID_CACHE_KEY) || '[]');
    const merged = new Set<string>(Array.isArray(existing) ? existing.filter((x) => typeof x === 'string') : []);
    INVALID_DEVICE_IDS.forEach((id) => merged.add(id));
    localStorage.setItem(INVALID_CACHE_KEY, JSON.stringify([...merged].slice(-300)));
  } catch {}
}

async function persistFreshDeviceId(id: string): Promise<void> {
  try { localStorage.setItem(DEVICE_ID_KEY, id); } catch {}
  try { sessionStorage.setItem(DEVICE_ID_KEY, id); } catch {}
  try { await secureSet(DEVICE_ID_KEY, id); } catch {}
  try { await nativeSet(DEVICE_ID_KEY, id); } catch {}
}

async function purgeLegacyRuntimeCachesOnce(): Promise<void> {
  try {
    if (localStorage.getItem(CLEAN_VERSION_KEY) === '1') return;
    localStorage.setItem(CLEAN_VERSION_KEY, '1');
  } catch {
    return;
  }

  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => /forsure|workbox|supabase-api/i.test(k)).map((k) => caches.delete(k)));
    }
  } catch {}

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.update().catch(() => undefined)));
    }
  } catch {}
}

export async function runE2EECleanStartup(): Promise<void> {
  rememberInvalidDevices();

  const stored = getStoredDeviceIds();
  if (stored.some((id) => INVALID_SET.has(id))) {
    await persistFreshDeviceId(generateDeviceId());
  }

  await purgeLegacyRuntimeCachesOnce();
}
