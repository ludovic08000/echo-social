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
let cachedFingerprints: { strict: string; loose: string; ultraLoose: string } | null = null;

/**
 * iOS Safari ITP rotates UA strings, screen metrics and locale subtly. We
 * therefore compute THREE candidate fingerprints from the most-stable to
 * the loosest, and the server tries them in order:
 *  - strict     : UA + lang + screen + tz + cpu  (matches a stable browser)
 *  - loose      : UA family (iPhone/iPad/Android) + tz                 (survives Safari version bumps)
 *  - ultraLoose : platform family only                                 (last-resort iOS recovery)
 */
async function sha256Hex(input: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  } catch {
    let h = 0;
    for (let i = 0; i < input.length; i++) h = ((h << 5) - h + input.charCodeAt(i)) | 0;
    return `fp${(h >>> 0).toString(16)}`;
  }
}

function uaFamily(ua: string): string {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPod/i.test(ua)) return 'iPod';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Unknown';
}

async function computeDeviceFingerprints(): Promise<{ strict: string; loose: string; ultraLoose: string }> {
  if (cachedFingerprints) return cachedFingerprints;
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const lang = (typeof navigator !== 'undefined' && navigator.language) || '';
  const cpu = String((typeof navigator !== 'undefined' && (navigator as any).hardwareConcurrency) || '');
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
  const screenStr = (() => {
    if (typeof screen === 'undefined') return '';
    // Use min/max so portrait/landscape rotation produces the same value (iOS quirk)
    const w = Math.min(screen.width, screen.height);
    const h = Math.max(screen.width, screen.height);
    return `${w}x${h}x${screen.colorDepth}`;
  })();
  const family = uaFamily(ua);

  const strict = await sha256Hex([ua, lang, cpu, tz, screenStr].join('|'));
  const loose = await sha256Hex([family, lang.split('-')[0] || '', tz].join('|'));
  const ultraLoose = await sha256Hex(`platform:${family}`);

  cachedFingerprints = { strict, loose, ultraLoose };
  try { localStorage.setItem(FINGERPRINT_KEY, strict); } catch {}
  return cachedFingerprints;
}

export async function getDeviceFingerprint(): Promise<string> {
  return (await computeDeviceFingerprints()).strict;
}

export async function getDeviceFingerprintCandidates(): Promise<string[]> {
  const fps = await computeDeviceFingerprints();
  return [fps.strict, fps.loose, fps.ultraLoose];
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

/**
 * Rotate away from a server-revoked routing id.
 *
 * Security invariant: a revoked device_id must never be silently reactivated.
 * When the server says the current id is revoked, we generate a fresh routing id
 * and persist it everywhere. Cryptographic identity keys remain account-scoped;
 * per-device KX/SPK/OPK material will be regenerated for the new id by the
 * registration flow.
 */
export function rotateCurrentDeviceId(reason = 'revoked-device'): string {
  const previous = memoryDeviceId || nativeGetSync(STORAGE_KEY) || null;
  const next = generateId();

  // Break any pending hydration cache so future startup code cannot overwrite
  // this new id with the just-rejected revoked value.
  hydrationPromise = null;

  console.warn('[device-id] rotating current device id', {
    reason,
    previous: previous ? previous.slice(0, 8) : 'none',
    next: next.slice(0, 8),
  });

  // Persist synchronously to memory + sync stores first. Native secure stores
  // (Keychain on iOS, Keystore on Android) are written fire-and-forget by
  // `persistEverywhere`. The next `hydrateDeviceId()` call races against
  // those writes; to stop the OLD revoked id from resurfacing, mark the
  // hydration cache as already resolved with the new id.
  persistEverywhere(next);
  hydrationPromise = Promise.resolve(next);
  return next;
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
      // 1) Native Keychain / Keystore is the strongest source of truth.
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

      // 2) Local storage / sessionStorage may already hold the id.
      const local = nativeGetSync(STORAGE_KEY);
      if (local) {
        return persistEverywhere(local);
      }

      // 3) Fall back to the SERVER fingerprint binding so iOS reuses the
      //    same device_id after Safari purges everything (ITP). This is
      //    what stops anciens messages from devenir undecipherable on
      //    every cold start.
      try {
        const candidates = await getDeviceFingerprintCandidates();
        const platform = getCurrentPlatform();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          const { data: serverId, error } = await supabase.rpc(
            'resolve_device_id_by_fingerprints' as any,
            { p_fingerprints: candidates, p_platform: platform },
          );
          if (!error && typeof serverId === 'string' && serverId.length >= 16) {
            console.log('[device-id] Recovered from server fingerprint binding', {
              recovered: serverId.slice(0, 8),
              platform,
            });
            return persistEverywhere(serverId);
          }
        }
      } catch (e) {
        console.warn('[device-id] server fingerprint lookup failed:', e);
      }

      // 4) Last resort: keep memory id or generate a fresh one.
      const current = memoryDeviceId || generateId();
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
