/**
 * Current device identity (multi-device E2EE).
 *
 * Stable per-account/per-installation identifier. The same physical browser can
 * log into multiple accounts, but E2EE device state must remain scoped to the
 * account. Signal/Aegis address devices as (UserID, DeviceID); sharing a single
 * browser-global device id across accounts lets device KX/SPK/ratchet state get
 * confused during account switching.
 *
 * Persistence multi-couche:
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

const BASE_STORAGE_KEY = 'forsure-device-id-v1';
const FINGERPRINT_KEY = 'forsure-device-fingerprint-v1';
const DEVICE_ID_DB = 'forsure-device-routing-v1';
const DEVICE_ID_STORE = 'device-ids';
let currentDeviceUserScope: string | null = null;
let memoryDeviceId: string | null = null;
let hydrationPromise: Promise<string> | null = null;
let memoryDeviceIdIsTemporary = false;
let cachedFingerprints: { strict: string; loose: string; ultraLoose: string } | null = null;

function storageKey(): string {
  return currentDeviceUserScope ? `${BASE_STORAGE_KEY}:${currentDeviceUserScope}` : BASE_STORAGE_KEY;
}

function readDeviceIdFromIndexedDb(key: string): Promise<string | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DEVICE_ID_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEVICE_ID_STORE)) {
        db.createObjectStore(DEVICE_ID_STORE);
      }
    };
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(DEVICE_ID_STORE, 'readonly');
      const get = transaction.objectStore(DEVICE_ID_STORE).get(key);
      get.onsuccess = () => {
        const value = get.result;
        resolve(typeof value === 'string' && value.length >= 16 ? value : null);
        db.close();
      };
      get.onerror = () => {
        resolve(null);
        db.close();
      };
    };
  });
}

function writeDeviceIdToIndexedDb(key: string, id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const request = indexedDB.open(DEVICE_ID_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEVICE_ID_STORE)) {
        db.createObjectStore(DEVICE_ID_STORE);
      }
    };
    request.onerror = () => resolve();
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(DEVICE_ID_STORE, 'readwrite');
      transaction.objectStore(DEVICE_ID_STORE).put(id, key);
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        resolve();
      };
    };
  });
}

/**
 * Scope the runtime device id to the authenticated account.
 * Must run before hydrateDeviceId() in account-aware flows.
 */
export function setCurrentDeviceUserScope(userId: string | null | undefined): void {
  const next = userId || null;
  if (currentDeviceUserScope === next) return;
  currentDeviceUserScope = next;
  memoryDeviceId = null;
  hydrationPromise = null;
  memoryDeviceIdIsTemporary = false;
  // Fingerprints are scoped to the account (see computeDeviceFingerprints) so a
  // browser hosting several accounts gives each its own device id. Drop the
  // cache when the account changes, otherwise the previous account's
  // fingerprint would leak into the next one.
  cachedFingerprints = null;

  // Do not synchronously copy the unscoped bootstrap ID into the account slot.
  // The account-scoped ID may still exist in IndexedDB even when localStorage
  // was cleared. hydrateDeviceId() checks every scoped layer first and only
  // adopts the bootstrap ID when no established scoped installation exists.
}

async function ensureUserScopeFromAuth(): Promise<void> {
  if (currentDeviceUserScope) return;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.id) setCurrentDeviceUserScope(user.id);
  } catch {
    // An unauthenticated bootstrap keeps the unscoped routing identity.
  }
}

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
  const cpu = String((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || '');
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
  const screenStr = (() => {
    if (typeof screen === 'undefined') return '';
    const w = Math.min(screen.width, screen.height);
    const h = Math.max(screen.width, screen.height);
    return `${w}x${h}x${screen.colorDepth}`;
  })();
  const family = uaFamily(ua);
  // Account scope: the SAME physical browser can host MULTIPLE accounts, and
  // each must get its OWN device id (and recover its own after a storage purge).
  // Without this, two accounts in one browser resolve to the SAME server device
  // binding -> identical device_id -> message routing between them breaks.
  const scope = currentDeviceUserScope || '';

  const strict = await sha256Hex([scope, ua, lang, cpu, tz, screenStr].join('|'));
  const loose = await sha256Hex([scope, family, lang.split('-')[0] || '', tz].join('|'));
  const ultraLoose = await sha256Hex(`platform:${family}:${scope}`);

  cachedFingerprints = { strict, loose, ultraLoose };
  try {
    localStorage.setItem(FINGERPRINT_KEY, strict);
  } catch {
    // Fingerprint persistence is advisory; the computed value remains usable.
  }
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
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function persistEverywhere(id: string): string {
  const key = storageKey();
  memoryDeviceId = id;
  memoryDeviceIdIsTemporary = false;
  try {
    localStorage.setItem(key, id);
  } catch {
    // Secure/native stores below are independent persistence layers.
  }
  try {
    sessionStorage.setItem(key, id);
  } catch {
    // Secure/native stores below are independent persistence layers.
  }
  void secureSet(key, id).catch(() => {});
  void nativeSet(key, id).catch(() => {});
  void writeDeviceIdToIndexedDb(key, id);
  return id;
}

export function setCurrentDeviceId(id: string): string {
  if (!id || typeof id !== 'string') return getCurrentDeviceId();
  if (memoryDeviceId === id) return id;
  hydrationPromise = null;
  console.log('[device-id] forcing device id from backup', { previous: memoryDeviceId?.slice(0, 8) ?? 'none', next: id.slice(0, 8), scoped: !!currentDeviceUserScope });
  return persistEverywhere(id);
}

/**
 * Adopt a device id coming from the ACCOUNT key backup — but ONLY when this
 * physical device has no stable id yet (fresh install / storage purge).
 *
 * The account backup is account-wide and syncs across every device. Forcing its
 * `device:id` on every restore overwrote the local, already-established
 * per-device id each session, so the id flipped between the locally-resolved one
 * and the backup one — orphaning published prekeys and breaking delivery. A
 * device id is per-physical-device (Signal/WhatsApp model) and must never be
 * dictated by the account backup once the device is established.
 */
export function adoptDeviceIdFromBackup(id: string): string {
  if (!id || typeof id !== 'string' || id.length < 16) return getCurrentDeviceId();

  const key = storageKey();
  const existing = memoryDeviceId || nativeGetSync(key);
  // Keep an already-established, non-temporary local id — never override it.
  if (existing && !memoryDeviceIdIsTemporary) {
    if (existing !== id) {
      console.log('[device-id] keeping stable local id; ignoring backup id', {
        local: existing.slice(0, 8), backup: id.slice(0, 8),
      });
    }
    memoryDeviceId = existing;
    return existing;
  }

  // No stable local id (fresh / purged) -> adopt the backup id for routing recovery.
  console.log('[device-id] adopting backup device id (no stable local id)', { next: id.slice(0, 8) });
  return persistEverywhere(id);
}

export function rotateCurrentDeviceId(reason = 'device-key-loss'): string {
  const key = storageKey();
  const previous = memoryDeviceId || nativeGetSync(key) || null;
  const next = generateId();
  hydrationPromise = null;

  console.warn('[device-id] rotating current device id', {
    reason,
    previous: previous ? previous.slice(0, 8) : 'none',
    next: next.slice(0, 8),
    scoped: !!currentDeviceUserScope,
  });

  persistEverywhere(next);
  hydrationPromise = Promise.resolve(next);
  return next;
}

export function getCurrentDeviceId(): string {
  if (memoryDeviceId) return memoryDeviceId;

  const key = storageKey();
  const localId = nativeGetSync(key);
  if (localId) {
    memoryDeviceId = localId;
    void nativeSet(key, localId).catch(() => {});
    return localId;
  }

  const fresh = generateId();
  // IndexedDB is asynchronous. Keep the first synchronous ID temporary until
  // hydrateDeviceId() has had a chance to recover the established installation
  // ID from every persistence layer. Persisting this provisional value here
  // could overwrite a valid IndexedDB ID after localStorage was cleared.
  memoryDeviceId = fresh;
  memoryDeviceIdIsTemporary = true;
  try {
    sessionStorage.setItem(key, fresh);
  } catch {
    // Hydration will persist the final stable ID when storage is available.
  }
  console.info('[device-id] generated temporary id pending durable hydration', {
    native: isNativePlatform(),
    scoped: !!currentDeviceUserScope,
  });
  return fresh;
}

export function isDeviceIdTemporary(): boolean {
  return memoryDeviceIdIsTemporary;
}

export async function hydrateDeviceId(): Promise<string> {
  await ensureUserScopeFromAuth();
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    try {
      const key = storageKey();
      const stored = await secureGet(key);
      if (stored) {
        if (memoryDeviceId && memoryDeviceId !== stored) {
          console.log('[device-id] Native store overrides in-memory id', {
            memory: memoryDeviceId.slice(0, 8),
            native: stored.slice(0, 8),
            temporary: memoryDeviceIdIsTemporary,
            scoped: !!currentDeviceUserScope,
          });
        }
        return persistEverywhere(stored);
      }

      const indexedDbId = await readDeviceIdFromIndexedDb(key);
      if (indexedDbId) {
        console.info('[device-id] restored stable installation id from IndexedDB', {
          id: indexedDbId.slice(0, 8),
          scoped: !!currentDeviceUserScope,
        });
        return persistEverywhere(indexedDbId);
      }

      const local = nativeGetSync(key);
      if (local) {
        return persistEverywhere(local);
      }

      if (currentDeviceUserScope) {
        const bootstrapId =
          await secureGet(BASE_STORAGE_KEY)
          ?? await readDeviceIdFromIndexedDb(BASE_STORAGE_KEY)
          ?? nativeGetSync(BASE_STORAGE_KEY);
        if (bootstrapId && bootstrapId.length >= 16) {
          return persistEverywhere(bootstrapId);
        }
      }

      // If every local persistence layer has disappeared, this is a new
      // logical Sesame device. Browser/OS fingerprints are deliberately not
      // used to reclaim a DeviceID: they are neither unique nor stable and can
      // route ciphertext to another installation.
      const current = memoryDeviceId || generateId();
      return persistEverywhere(current);
    } catch (e) {
      console.warn('[device-id] hydration failed:', e);
      return memoryDeviceId || persistEverywhere(generateId());
    }
  })();
  return hydrationPromise;
}

export function getCurrentDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Unknown device';
  const ua = navigator.userAgent || '';
  const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const os =
    /iPhone/i.test(ua) ? 'iPhone'
    : /iPad|iPod/i.test(ua) || isIPadOS ? 'iPad'
    : /Android/i.test(ua) ? 'Android'
    : /Windows/i.test(ua) ? 'Windows'
    : /Macintosh|Mac OS X/i.test(ua) ? 'macOS'
    : /Linux/i.test(ua) ? 'Linux'
    : 'Unknown OS';
  const browser =
    /EdgA?|EdgiOS/i.test(ua) ? 'Edge'
    : /CriOS|Chrome/i.test(ua) ? 'Chrome'
    : /FxiOS|Firefox/i.test(ua) ? 'Firefox'
    : /OPiOS|OPR\//i.test(ua) ? 'Opera'
    : /Safari/i.test(ua) ? 'Safari'
    : 'Browser';
  if (isNativePlatform()) {
    return `${os} · App`;
  }
  return `${browser} · ${os}`;
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
  if (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  return 'web';
}
