/**
 * secureStore — Hardware-backed secret storage.
 *
 * iOS  → Keychain Services (kSecAttrAccessibleAfterFirstUnlock)
 * Android → Android Keystore (AES-GCM, hardware-backed when available)
 * Web / fallback → Capacitor Preferences then localStorage (NOT secure — best-effort)
 *
 * Use this for values that must NEVER leak between apps and must survive
 * WebView cache purges:
 *   - device id (routing label)
 *   - account-key sentinel (digest of last successful master-key sync)
 *   - any small client secret that doesn't belong in IndexedDB
 *
 * Real E2EE key material still lives in IndexedDB (encrypted at rest by the OS),
 * but the pointers / wrappers are anchored here so the device can re-link itself
 * after a wipe.
 */

import { Capacitor } from '@capacitor/core';
import { nativeGet, nativeSet, nativeRemove } from '@/lib/nativeStore';

type SecurePlugin = {
  get: (opts: { key: string }) => Promise<{ value: string }>;
  set: (opts: { key: string; value: string }) => Promise<{ value: boolean }>;
  remove: (opts: { key: string }) => Promise<{ value: boolean }>;
  keys: () => Promise<{ value: string[] }>;
  clear: () => Promise<{ value: boolean }>;
};

let _secure: SecurePlugin | null = null;
let _loading: Promise<void> | null = null;

const isNative = (): boolean => {
  try { return Capacitor.isNativePlatform?.() === true; } catch { return false; }
};

async function ensureSecure(): Promise<void> {
  if (_secure || !isNative()) return;
  if (!_loading) {
    _loading = import('capacitor-secure-storage-plugin')
      .then((m) => {
        _secure = (m.SecureStoragePlugin as unknown) as SecurePlugin;
      })
      .catch((e) => {
        console.warn('[secureStore] secure storage plugin unavailable, falling back to Preferences:', e);
      });
  }
  await _loading;
}

export async function secureGet(key: string): Promise<string | null> {
  await ensureSecure();
  if (_secure) {
    try {
      const { value } = await _secure.get({ key });
      if (value != null) return value;
    } catch {
      // Plugin throws on missing key — silently fall through
    }
  }
  return nativeGet(key);
}

export async function secureSet(key: string, value: string): Promise<void> {
  await ensureSecure();
  if (_secure) {
    try {
      await _secure.set({ key, value });
      // Also mirror to Preferences so synchronous WebView reads still work.
      await nativeSet(key, value);
      return;
    } catch (e) {
      console.warn('[secureStore] set failed, falling back:', key, e);
    }
  }
  await nativeSet(key, value);
}

export async function secureRemove(key: string): Promise<void> {
  await ensureSecure();
  if (_secure) {
    try { await _secure.remove({ key }); } catch {}
  }
  await nativeRemove(key);
}

export function isSecureStoreNative(): boolean {
  return isNative();
}
