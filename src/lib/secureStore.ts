/**
 * secureStore — Hardware-backed secret storage with health-checked fallback.
 *
 * iOS  → Keychain Services (kSecAttrAccessibleAfterFirstUnlock)
 * Android → Android Keystore (AES-GCM, hardware-backed when available)
 * Web / fallback → Capacitor Preferences then localStorage (NOT secure — best-effort)
 *
 * Use this for values that must NEVER leak between apps and must survive
 * WebView cache purges:
 *   - device id (routing label)
 *   - account-key sentinel (digest of last successful master-key sync)
 *
 * On startup, `verifySecureStoreHealth()` runs a probe + cross-checks the
 * Keychain/Keystore against the Preferences mirror. The result drives the
 * reconciliation strategy used by callers (e.g. keySentinel).
 */

import { Capacitor } from '@capacitor/core';
import { nativeGet, nativeSet, nativeRemove, nativeGetSync } from '@/lib/nativeStore';

type SecurePlugin = {
  get: (opts: { key: string }) => Promise<{ value: string }>;
  set: (opts: { key: string; value: string }) => Promise<{ value: boolean }>;
  remove: (opts: { key: string }) => Promise<{ value: boolean }>;
  keys: () => Promise<{ value: string[] }>;
  clear: () => Promise<{ value: boolean }>;
};

let _secure: SecurePlugin | null = null;
let _loading: Promise<void> | null = null;
let _pluginAvailable: boolean | null = null;

const PROBE_KEY = '__forsure_secure_probe__';
const SECRET_CHUNK_SIZE = 24_000;

const secretMetaKey = (key: string) => `${key}.__chunks__`;
const secretChunkKey = (key: string, index: number) => `${key}.__chunk_${index}__`;

const isNative = (): boolean => {
  try { return Capacitor.isNativePlatform?.() === true; } catch { return false; }
};

async function ensureSecure(): Promise<void> {
  if (_secure || !isNative()) return;
  if (!_loading) {
    _loading = import('capacitor-secure-storage-plugin')
      .then((m) => {
        _secure = (m.SecureStoragePlugin as unknown) as SecurePlugin;
        _pluginAvailable = true;
      })
      .catch((e) => {
        _pluginAvailable = false;
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
  let secureOk = false;
  if (_secure) {
    try {
      await _secure.set({ key, value });
      secureOk = true;
    } catch (e) {
      console.warn('[secureStore] set failed:', key, e);
    }
  }
  // Always mirror to Preferences so synchronous WebView reads still work,
  // and so we have something to detect drift against.
  await nativeSet(key, value);
  if (isNative() && !secureOk) {
    console.warn('[secureStore] value persisted to fallback only:', key);
  }
}

/**
 * Store secret material ONLY in the platform secure store.
 * Unlike secureSet(), this intentionally does not mirror to Preferences or
 * localStorage, so E2EE key snapshots never leak into non-secure storage.
 */
export async function secureSetSecret(key: string, value: string): Promise<boolean> {
  await ensureSecure();
  if (!_secure) {
    // Only warn on native platforms where the plugin is expected.
    // On web there is no Keychain/Keystore — this is the normal code path.
    if (isNative()) {
      console.warn('[secureStore] secret write skipped — secure plugin unavailable:', key);
    }
    return false;
  }

  try {
    const chunks = value.match(new RegExp(`.{1,${SECRET_CHUNK_SIZE}}`, 'gs')) ?? [''];
    await _secure.set({ key, value: chunks.length === 1 ? value : '' });
    await _secure.set({ key: secretMetaKey(key), value: String(chunks.length) });
    await Promise.all(chunks.map((chunk, index) => _secure!.set({
      key: secretChunkKey(key, index),
      value: chunk,
    })));
    return true;
  } catch (e) {
    console.warn('[secureStore] secret set failed:', key, e);
    return false;
  }
}

/** Read secret material from Keychain/Keystore only. No fallback mirror. */
export async function secureGetSecret(key: string): Promise<string | null> {
  await ensureSecure();
  if (!_secure) return null;

  try {
    let chunkCount = 0;
    try {
      const meta = await _secure.get({ key: secretMetaKey(key) });
      chunkCount = Number(meta.value || 0);
    } catch {
      chunkCount = 0;
    }

    if (chunkCount > 1) {
      const chunks = await Promise.all(Array.from({ length: chunkCount }, (_, index) =>
        _secure!.get({ key: secretChunkKey(key, index) }).then((r) => r.value),
      ));
      return chunks.join('');
    }

    const { value } = await _secure.get({ key });
    return value ?? null;
  } catch {
    return null;
  }
}

/** Remove secret material from Keychain/Keystore only. */
export async function secureRemoveSecret(key: string): Promise<void> {
  await ensureSecure();
  if (!_secure) return;
  let chunkCount = 0;
  try {
    const meta = await _secure.get({ key: secretMetaKey(key) });
    chunkCount = Number(meta.value || 0);
  } catch {}
  await Promise.all([
    _secure.remove({ key }).catch(() => {}),
    _secure.remove({ key: secretMetaKey(key) }).catch(() => {}),
    ...Array.from({ length: chunkCount }, (_, index) =>
      _secure!.remove({ key: secretChunkKey(key, index) }).catch(() => {}),
    ),
  ]);
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

/** Last-known plugin availability. `null` until first ensureSecure() resolves. */
export function isSecurePluginAvailable(): boolean | null {
  if (!isNative()) return false;
  return _pluginAvailable;
}

// ── Health check & reconciliation ──────────────────────────────────────────

export type SecureStoreTier =
  | 'keychain'        // iOS/Android secure storage healthy
  | 'preferences'     // Native Preferences only (plugin missing/broken)
  | 'web';            // Browser localStorage (best-effort)

export interface SecureStoreHealth {
  tier: SecureStoreTier;
  pluginAvailable: boolean;
  probeRoundTripOk: boolean;
  driftedKeys: string[];   // keys where Keychain != Preferences
  reconciled: number;      // keys auto-fixed by copying Keychain → Preferences
  warnings: string[];
}

let _healthCache: SecureStoreHealth | null = null;
let _healthPromise: Promise<SecureStoreHealth> | null = null;

/**
 * Run on app startup. Verifies the secure plugin works and reconciles drift
 * between Keychain/Keystore and the Preferences mirror.
 *
 * Drift policy: the Keychain/Keystore is authoritative when present, because
 * Preferences can be wiped by the user via "Clear app data" while the Keychain
 * survives. If a key exists in Keychain but not in Preferences, we copy it
 * forward. If a key exists only in Preferences, we leave it (it may simply be
 * a non-secure value).
 */
export async function verifySecureStoreHealth(
  watchedKeys: string[] = [],
): Promise<SecureStoreHealth> {
  if (_healthCache) return _healthCache;
  if (_healthPromise) return _healthPromise;

  _healthPromise = (async () => {
    const warnings: string[] = [];
    const driftedKeys: string[] = [];
    let reconciled = 0;

    if (!isNative()) {
      const result: SecureStoreHealth = {
        tier: 'web',
        pluginAvailable: false,
        probeRoundTripOk: false,
        driftedKeys,
        reconciled,
        warnings,
      };
      _healthCache = result;
      return result;
    }

    await ensureSecure();
    const pluginAvailable = !!_secure;

    let probeRoundTripOk = false;
    if (_secure) {
      try {
        const probeValue = `probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await _secure.set({ key: PROBE_KEY, value: probeValue });
        const readBack = await _secure.get({ key: PROBE_KEY });
        probeRoundTripOk = readBack?.value === probeValue;
        try { await _secure.remove({ key: PROBE_KEY }); } catch {}
        if (!probeRoundTripOk) {
          warnings.push('Keychain probe round-trip mismatch');
        }
      } catch (e) {
        warnings.push(`Keychain probe failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      warnings.push('Secure storage plugin not available — using Preferences fallback');
    }

    if (_secure && probeRoundTripOk) {
      for (const key of watchedKeys) {
        try {
          let secureValue: string | null = null;
          try { secureValue = (await _secure.get({ key })).value ?? null; } catch { secureValue = null; }
          const mirroredValue = nativeGetSync(key) ?? (await nativeGet(key));

          if (secureValue && secureValue !== mirroredValue) {
            driftedKeys.push(key);
            // Reconcile: Keychain wins, push to Preferences mirror.
            await nativeSet(key, secureValue);
            reconciled++;
            console.log('[secureStore] reconciled drift on', key);
          } else if (!secureValue && mirroredValue) {
            // Mirror has a value the Keychain lost (rare — possibly a fallback-only write
            // from a previous session where the plugin was missing). Promote it.
            try {
              await _secure.set({ key, value: mirroredValue });
              reconciled++;
              console.log('[secureStore] promoted fallback value to Keychain:', key);
            } catch (e) {
              warnings.push(`failed to promote ${key}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        } catch (e) {
          warnings.push(`reconcile failed for ${key}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    const tier: SecureStoreTier = (_secure && probeRoundTripOk) ? 'keychain' : 'preferences';
    const result: SecureStoreHealth = {
      tier,
      pluginAvailable,
      probeRoundTripOk,
      driftedKeys,
      reconciled,
      warnings,
    };
    _healthCache = result;
    console.log('[secureStore] health check', result);
    return result;
  })();

  return _healthPromise;
}

/** Returns the cached health report from the last verifySecureStoreHealth() call. */
export function getSecureStoreHealth(): SecureStoreHealth | null {
  return _healthCache;
}
