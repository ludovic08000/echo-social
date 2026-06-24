/**
 * Current device identity (multi-device E2EE).
 *
 * Stable per-account/per-installation identifier. The same physical browser can
 * log into multiple accounts, but E2EE device state must remain scoped to the
 * account. Signal/Sesame address devices as (UserID, DeviceID); sharing a single
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
let currentDeviceUserScope: string | null = null;
let memoryDeviceId: string | null = null;
let hydrationPromise: Promise<string> | null = null;
let memoryDeviceIdIsTemporary = false;
let cachedFingerprints: { strict: string; loose: string; ultraLoose: string } | null = null;

const BLOCKED_RECOVERY_DEVICE_IDS = new Set<string>([
  '84aaa52143235807214bf3aa161dd03a',
  '6508eb47a200893f49720fe84b9290b3',
  '9da8c742a4fe81d1d9ce6c0ffb4e055b',
  '75e575fcbfaa8066bcbc9105fc5f4ac8',
  'c6601674b0f700f28c9f2956774eca97',
  '52adb13ff236ae5c833c9d9049c0df71',
  'b166de502d729356dcbd6c0b5b1a39b0',
  '49cfdeab59355de3051925b4f09fba75',
  '92585130870cedf210af1019379dbc61',
  '450c0cd9af35813c8a99ec5bc0f39ab8',
]);

function storageKey(): string {
  return currentDeviceUserScope ? `${BASE_STORAGE_KEY}:${currentDeviceUserScope}` : BASE_STORAGE_KEY;
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

  // Seed the per-account device id from the PRE-SCOPE (unscoped) id.
  //
  // Before the account is known (e.g. hydrateDeviceId running at app mount
  // while the session is still restoring), the device id is resolved and
  // persisted under the UNSCOPED key. When we then switch to the scoped key
  // for the first time, that scoped slot is empty -> getCurrentDeviceId()
  // would mint a BRAND NEW id, orphaning the device the account already has
  // and forcing a full re-registration every session. That churn leaves stale
  // `user_devices` rows behind (one of them may stay marked primary), which is
  // the root cause of the cross-device "empty blue bubble". Carry the already
  // established id over to the account slot instead of generating a new one.
  if (next) {
    try {
      const scopedKey = `${BASE_STORAGE_KEY}:${next}`;
      const scoped = nativeGetSync(scopedKey);
      if (!scoped) {
        const unscoped = nativeGetSync(BASE_STORAGE_KEY);
        if (unscoped && unscoped.length >= 16 && !isBlockedRecoveryDeviceId(unscoped)) {
          memoryDeviceId = unscoped;
          memoryDeviceIdIsTemporary = false;
          hydrationPromise = Promise.resolve(unscoped);
          try { localStorage.setItem(scopedKey, unscoped); } catch {}
          try { sessionStorage.setItem(scopedKey, unscoped); } catch {}
          void secureSet(scopedKey, unscoped).catch(() => {});
          void nativeSet(scopedKey, unscoped).catch(() => {});
          console.log('[device-id] seeded per-account id from pre-scope id', {
            id: unscoped.slice(0, 8), account: next.slice(0, 8),
          });
        }
      }
    } catch {}
  }
}

async function ensureUserScopeFromAuth(): Promise<void> {
  if (currentDeviceUserScope) return;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user?.id) setCurrentDeviceUserScope(user.id);
  } catch {}
}

function isBlockedRecoveryDeviceId(id: string | null | undefined): boolean {
  return !!id && BLOCKED_RECOVERY_DEVICE_IDS.has(id);
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
  const cpu = String((typeof navigator !== 'undefined' && (navigator as any).hardwareConcurrency) || '');
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
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function persistEverywhere(id: string): string {
  const key = storageKey();
  memoryDeviceId = id;
  memoryDeviceIdIsTemporary = false;
  try { localStorage.setItem(key, id); } catch {}
  try { sessionStorage.setItem(key, id); } catch {}
  void secureSet(key, id).catch(() => {});
  void nativeSet(key, id).catch(() => {});
  return id;
}

export function setCurrentDeviceId(id: string): string {
  if (!id || typeof id !== 'string') return getCurrentDeviceId();
  if (isBlockedRecoveryDeviceId(id)) return rotateCurrentDeviceId('blocked-recovery-device');
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
  if (isBlockedRecoveryDeviceId(id)) return getCurrentDeviceId();

  const key = storageKey();
  const existing = memoryDeviceId || nativeGetSync(key);
  // Keep an already-established, non-temporary local id — never override it.
  if (existing && !memoryDeviceIdIsTemporary && !isBlockedRecoveryDeviceId(existing)) {
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

export function rotateCurrentDeviceId(reason = 'revoked-device'): string {
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
    if (isBlockedRecoveryDeviceId(localId)) return persistEverywhere(generateId());
    memoryDeviceId = localId;
    void nativeSet(key, localId).catch(() => {});
    return localId;
  }

  const fresh = generateId();
  if (isNativePlatform()) {
    memoryDeviceId = fresh;
    memoryDeviceIdIsTemporary = true;
    try { sessionStorage.setItem(key, fresh); } catch {}
    console.log('[device-id] Generated temporary device id pending native hydration');
    return fresh;
  }
  console.log('[device-id] Generated new device id (no persisted value found)', { scoped: !!currentDeviceUserScope });
  return persistEverywhere(fresh);
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
        if (isBlockedRecoveryDeviceId(stored)) return persistEverywhere(generateId());
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

      const local = nativeGetSync(key);
      if (local) {
        if (isBlockedRecoveryDeviceId(local)) return persistEverywhere(generateId());
        return persistEverywhere(local);
      }

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
            if (isBlockedRecoveryDeviceId(serverId)) return persistEverywhere(generateId());
            console.log('[device-id] Recovered from server fingerprint binding', {
              recovered: serverId.slice(0, 8),
              platform,
              scoped: !!currentDeviceUserScope,
            });
            return persistEverywhere(serverId);
          }
        }
      } catch (e) {
        console.warn('[device-id] server fingerprint lookup failed:', e);
      }

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
