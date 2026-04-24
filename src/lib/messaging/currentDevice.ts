/**
 * Current device identity (multi-device E2EE).
 *
 * Stable per-installation identifier. Persistance multi-couche :
 *  1. Mémoire (runtime)
 *  2. localStorage / sessionStorage (web + WebView)
 *  3. Capacitor Preferences (UserDefaults iOS / SharedPreferences Android)
 *     → survit aux purges de cache WebView, aux mises à jour de l'app,
 *       aux faibles mémoires iOS.
 *
 * Used to:
 *  - register the device in `user_devices` at login
 *  - tag outgoing message copies (sender_device_id)
 *  - fetch incoming copies addressed to this device
 *
 * NOTE: this is NOT a cryptographic identity by itself — it's a routing label.
 * The actual E2EE key material lives in IndexedDB (ratchet states, identity keys).
 */

import { nativeGet, nativeSet, nativeGetSync, isNativePlatform } from '@/lib/nativeStore';

const STORAGE_KEY = 'forsure-device-id-v1';
let memoryDeviceId: string | null = null;
let hydrationPromise: Promise<string> | null = null;

function generateId(): string {
  // 32-char hex (128 bits of entropy)
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function persistEverywhere(id: string): string {
  memoryDeviceId = id;
  try { localStorage.setItem(STORAGE_KEY, id); } catch {}
  try { sessionStorage.setItem(STORAGE_KEY, id); } catch {}
  // Fire-and-forget native persistence
  void nativeSet(STORAGE_KEY, id).catch(() => {});
  return id;
}

/**
 * Synchronous accessor — used everywhere today.
 * On native platforms, the first call after install may return a fresh ID
 * if hydration hasn't completed yet. Call `hydrateDeviceId()` once at app
 * startup to guarantee the persisted native value wins.
 */
export function getCurrentDeviceId(): string {
  if (memoryDeviceId) return memoryDeviceId;

  const localId = nativeGetSync(STORAGE_KEY);
  if (localId) {
    memoryDeviceId = localId;
    // Also push to native store on first read (covers PWA → native upgrade)
    void nativeSet(STORAGE_KEY, localId).catch(() => {});
    return localId;
  }

  // Last-resort fallback: create a new ID immediately
  const fresh = generateId();
  console.log('[device-id] Generated new device id (no persisted value found)');
  return persistEverywhere(fresh);
}

/**
 * Hydrate the device id from native storage at app startup.
 * On iOS/Android, the native Preferences value is the source of truth and
 * may differ from a freshly-generated WebView id if IndexedDB/localStorage
 * was wiped by the OS.
 */
export async function hydrateDeviceId(): Promise<string> {
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    try {
      const stored = await nativeGet(STORAGE_KEY);
      if (stored) {
        if (memoryDeviceId && memoryDeviceId !== stored) {
          console.log('[device-id] Native store overrides in-memory id', {
            memory: memoryDeviceId.slice(0, 8),
            native: stored.slice(0, 8),
          });
        }
        return persistEverywhere(stored);
      }
      const current = memoryDeviceId || nativeGetSync(STORAGE_KEY) || generateId();
      return persistEverywhere(current);
    } catch (e) {
      console.warn('[device-id] hydration failed:', e);
      return memoryDeviceId || persistEverywhere(generateId());
    }
  })();
  return hydrationPromise;
}

/** Best-effort device label for the user_devices registry */
export function getCurrentDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Unknown device';
  const ua = navigator.userAgent || '';
  if (isNativePlatform()) {
    if (/iPhone/i.test(ua)) return 'iPhone (App)';
    if (/iPad/i.test(ua)) return 'iPad (App)';
    if (/Android/i.test(ua)) return 'Android (App)';
    return 'Mobile App';
  }
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mac/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Browser';
}

export function getCurrentPlatform(): string {
  if (isNativePlatform()) {
    if (typeof navigator !== 'undefined') {
      const ua = navigator.userAgent || '';
      if (/Android/i.test(ua)) return 'android';
      if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    }
    return 'mobile';
  }
  if (typeof navigator === 'undefined') return 'web';
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  return 'web';
}
