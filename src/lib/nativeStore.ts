/**
 * nativeStore — Cross-platform persistent key/value store.
 *
 * Web → localStorage (best-effort)
 * iOS / Android (Capacitor) → @capacitor/preferences (UserDefaults / SharedPreferences)
 *   → survives WebView cache purges, PWA reinstalls, low-memory cleanups.
 *
 * Used as a durable mirror for critical small values:
 *   - device_id (routing label, must persist forever)
 *   - last known userId (to associate the device on cold-start)
 *   - account-key sync sentinel (digest of last successful upload)
 *
 * NOTE: We never store secret key material here — only metadata + identifiers.
 * Real E2EE key material lives in IndexedDB (encrypted at rest by the OS on iOS/Android).
 */

import { Capacitor } from '@capacitor/core';

let _prefs: typeof import('@capacitor/preferences').Preferences | null = null;
let _prefsLoading: Promise<void> | null = null;

const isNative = (): boolean => {
  try {
    return Capacitor.isNativePlatform?.() === true;
  } catch {
    return false;
  }
};

async function ensurePrefs(): Promise<void> {
  if (_prefs || !isNative()) return;
  if (!_prefsLoading) {
    _prefsLoading = import('@capacitor/preferences')
      .then((m) => {
        _prefs = m.Preferences;
      })
      .catch((e) => {
        console.warn('[nativeStore] Preferences unavailable:', e);
      });
  }
  await _prefsLoading;
}

export async function nativeGet(key: string): Promise<string | null> {
  await ensurePrefs();
  if (_prefs) {
    try {
      const { value } = await _prefs.get({ key });
      if (value != null) return value;
    } catch (e) {
      console.warn('[nativeStore] get failed:', key, e);
    }
  }
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function nativeSet(key: string, value: string): Promise<void> {
  await ensurePrefs();
  if (_prefs) {
    try {
      await _prefs.set({ key, value });
    } catch (e) {
      console.warn('[nativeStore] set failed:', key, e);
    }
  }
  try {
    localStorage.setItem(key, value);
  } catch {}
  try {
    sessionStorage.setItem(key, value);
  } catch {}
}

export async function nativeRemove(key: string): Promise<void> {
  await ensurePrefs();
  if (_prefs) {
    try {
      await _prefs.remove({ key });
    } catch {}
  }
  try {
    localStorage.removeItem(key);
  } catch {}
  try {
    sessionStorage.removeItem(key);
  } catch {}
}

/** Synchronous best-effort read — used during sync code paths. Falls back to localStorage. */
export function nativeGetSync(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }
}

export function isNativePlatform(): boolean {
  return isNative();
}
