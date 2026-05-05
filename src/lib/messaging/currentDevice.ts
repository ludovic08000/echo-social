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

import { nativeSet, nativeGetSync, isNativePlatform } from '@/lib/nativeStore';
import { secureGet, secureSet } from '@/lib/secureStore';
import { supabase } from '@/integrations/supabase/client';

const STORAGE_KEY = 'forsure-device-id-v1';
const FINGERPRINT_KEY = 'forsure-device-fingerprint-v1';
let memoryDeviceId: string | null = null;
let hydrationPromise: Promise<string> | null = null;
let memoryDeviceIdIsTemporary = false;
let cachedFingerprint: string | null = null;

/**
 * Stable per-installation fingerprint (UA + screen + lang + tz). Survives
 * Safari ITP storage purges because it's recomputed from the environment,
 * never read from cleared storage. Used by the server-side
 * `resolve_device_id_by_fingerprint` RPC to recover the previous
 * `device_id` after iOS wipes IndexedDB / localStorage / Keychain.
 */
async function computeDeviceFingerprint(): Promise<string> {
  if (cachedFingerprint) return cachedFingerprint;
  const parts: string[] = [];
  try {
    if (typeof navigator !== 'undefined') {
      parts.push(navigator.userAgent || '');
      parts.push(navigator.language || '');
      parts.push(String((navigator as any).hardwareConcurrency || ''));
      parts.push(String((navigator as any).deviceMemory || ''));
    }
    if (typeof screen !== 'undefined') {
      parts.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);
    }
    parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone || '');
  } catch {}
  const raw = parts.join('|');
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    cachedFingerprint = Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  } catch {
    // crypto.subtle missing — fall back to a non-crypto hash so RPC still works.
    let h = 0;
    for (let i = 0; i < raw.length; i++) h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
    cachedFingerprint = `fp${(h >>> 0).toString(16)}`;
  }
  return cachedFingerprint;
}

export async function getDeviceFingerprint(): Promise<string> {
  return computeDeviceFingerprint();
}

function generateId(): string {
  // 32-char hex (128 bits of entropy)
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function persistEverywhere(id: string): string {
  memoryDeviceId = id;
  memoryDeviceIdIsTemporary = false;
  try { localStorage.setItem(STORAGE_KEY, id); } catch {}
  try { sessionStorage.setItem(STORAGE_KEY, id); } catch {}
  // Fire-and-forget native persistence (Keychain on iOS, Keystore on Android,
  // Preferences as a synchronous-readable mirror).
  void secureSet(STORAGE_KEY, id).catch(() => {});
  void nativeSet(STORAGE_KEY, id).catch(() => {});
  return id;
}

/**
 * Synchronous accessor — used everywhere today.
 * On native platforms, the first call after install may return a fresh ID
 * if hydration hasn't completed yet. Call `hydrateDeviceId()` once at app
 * startup to guarantee the persisted native value wins.
 */
/**
 * Force a specific device id to become the current one (memory + native + secure stores).
 * Used by the backup/restore path to recover the original device id of an account
 * after iOS purges IndexedDB/Keychain — otherwise message device-copies become
 * undecryptable because they target the previous device_id.
 */
export function setCurrentDeviceId(id: string): string {
  if (!id || typeof id !== 'string') return getCurrentDeviceId();
  if (memoryDeviceId === id) return id;
  console.log('[device-id] forcing device id from backup', { previous: memoryDeviceId?.slice(0, 8) ?? 'none', next: id.slice(0, 8) });
  return persistEverywhere(id);
}

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
  // On native, do NOT immediately persist a synchronous fallback to Keychain.
  // Capacitor Preferences/Keychain are async; if WebView storage was wiped,
  // persisting here can overwrite the surviving Keychain id before
  // hydrateDeviceId() has a chance to read it, causing device_id drift.
  if (isNativePlatform()) {
    memoryDeviceId = fresh;
    memoryDeviceIdIsTemporary = true;
    try { sessionStorage.setItem(STORAGE_KEY, fresh); } catch {}
    console.log('[device-id] Generated temporary device id pending native hydration');
    return fresh;
  }
  console.log('[device-id] Generated new device id (no persisted value found)');
  return persistEverywhere(fresh);
}

/**
 * True when the in-memory id was generated as a fallback while native
 * hydration is still pending. Crypto layers should defer X3DH bootstrap
 * (which would otherwise pin a session to an ephemeral id) until this
 * returns false.
 */
export function isDeviceIdTemporary(): boolean {
  return memoryDeviceIdIsTemporary;
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
      // Keychain / Keystore is the source of truth on native; falls back to
      // Preferences then localStorage automatically.
      const stored = await secureGet(STORAGE_KEY);
      if (stored) {
        if (memoryDeviceId && memoryDeviceId !== stored) {
          console.log('[device-id] Native store overrides in-memory id', {
            memory: memoryDeviceId.slice(0, 8),
            native: stored.slice(0, 8),
            temporary: memoryDeviceIdIsTemporary,
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
