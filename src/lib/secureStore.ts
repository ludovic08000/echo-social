/**
 * Platform secure storage.
 *
 * Legacy non-critical APIs preserve the Preferences mirror used for routing
 * labels and health reconciliation. E2EE private material must use the
 * `*CriticalSecret` APIs, which are native-only and fail closed.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import { nativeGet, nativeGetSync, nativeRemove, nativeSet } from '@/lib/nativeStore';
import { isVerifiedNativeRuntime } from '@/lib/runtimePlatform';

type AegisKeychainBridge = {
  get(options: { key: string }): Promise<{ value?: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
};

const AegisKeychain = registerPlugin<AegisKeychainBridge>('AegisKeychain');
const CRITICAL_PREFIX = 'forsure.secure.v1:';
const PROBE_KEY = '__forsure_secure_probe__';
const SECRET_CHUNK_SIZE = 24_000;

const secretMetaKey = (key: string) => `${key}.__chunks__`;
const secretChunkKey = (key: string, index: number) => `${key}.__chunk_${index}__`;

export class NativeSecureStoreUnavailableError extends Error {
  readonly operation: 'get' | 'set' | 'remove';

  constructor(operation: 'get' | 'set' | 'remove', cause?: unknown) {
    super(`E2EE_NATIVE_KEYCHAIN_UNAVAILABLE:${operation}`);
    this.name = 'NativeSecureStoreUnavailableError';
    this.operation = operation;
    if (cause !== undefined) {
      Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
    }
  }
}

export function isSecureStoreNative(): boolean {
  return isVerifiedNativeRuntime();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isMissingItemError(error: unknown): boolean {
  return /does not exist|not found|missing item|no value/i.test(errorMessage(error));
}

function criticalKey(key: string): string {
  return `${CRITICAL_PREFIX}${key}`;
}

function isIOSNative(): boolean {
  return isSecureStoreNative() && Capacitor.getPlatform() === 'ios';
}

async function criticalPlatformGet(key: string): Promise<string | null> {
  if (isIOSNative()) {
    const result = await AegisKeychain.get({ key });
    return typeof result?.value === 'string' ? result.value : null;
  }
  return rawSecureGet(key);
}

async function criticalPlatformSet(key: string, value: string): Promise<void> {
  if (isIOSNative()) {
    await AegisKeychain.set({ key, value });
    return;
  }
  await SecureStoragePlugin.set({ key, value });
}

async function criticalPlatformRemove(key: string): Promise<void> {
  if (isIOSNative()) {
    await AegisKeychain.remove({ key });
    return;
  }
  await rawSecureRemove(key);
}

async function rawSecureGet(key: string): Promise<string | null> {
  try {
    const result = await SecureStoragePlugin.get({ key });
    return typeof result?.value === 'string' ? result.value : null;
  } catch (error) {
    if (isMissingItemError(error)) return null;
    throw error;
  }
}

async function rawSecureRemove(key: string): Promise<void> {
  try {
    await SecureStoragePlugin.remove({ key });
  } catch (error) {
    if (!isMissingItemError(error)) throw error;
  }
}

/** Native Keychain/Keystore only. Never Preferences/localStorage. */
export async function secureGetCriticalSecret(key: string): Promise<string | null> {
  if (!isSecureStoreNative()) return null;
  try {
    return await criticalPlatformGet(criticalKey(key));
  } catch (error) {
    throw new NativeSecureStoreUnavailableError('get', error);
  }
}

/** Native Keychain/Keystore only, with mandatory readback. */
export async function secureSetCriticalSecret(key: string, value: string): Promise<void> {
  if (!isSecureStoreNative()) {
    throw new NativeSecureStoreUnavailableError('set', 'native platform required');
  }
  try {
    await criticalPlatformSet(criticalKey(key), value);
  } catch (error) {
    throw new NativeSecureStoreUnavailableError('set', error);
  }
  const readback = await secureGetCriticalSecret(key);
  if (readback !== value) {
    throw new NativeSecureStoreUnavailableError('set', 'keychain readback mismatch');
  }
}

/** Native Keychain/Keystore only, with mandatory deletion readback. */
export async function secureRemoveCriticalSecret(key: string): Promise<void> {
  if (!isSecureStoreNative()) {
    throw new NativeSecureStoreUnavailableError('remove', 'native platform required');
  }
  try {
    await criticalPlatformRemove(criticalKey(key));
  } catch (error) {
    throw new NativeSecureStoreUnavailableError('remove', error);
  }
  const readback = await secureGetCriticalSecret(key);
  if (readback !== null) {
    throw new NativeSecureStoreUnavailableError('remove', 'keychain delete readback mismatch');
  }
}

/**
 * Legacy non-critical mirrored storage. The secure copy wins when present;
 * Preferences/localStorage remains a compatibility mirror only.
 */
export async function secureGet(key: string): Promise<string | null> {
  if (isSecureStoreNative()) {
    try {
      const secure = await rawSecureGet(key);
      if (secure !== null) return secure;
    } catch {
      // Non-critical callers may use the established mirror.
    }
  }
  return nativeGet(key);
}

export async function secureSet(key: string, value: string): Promise<void> {
  if (isSecureStoreNative()) {
    try {
      await SecureStoragePlugin.set({ key, value });
    } catch {
      // The mirror is intentionally retained for non-critical values.
    }
  }
  await nativeSet(key, value);
}

export async function secureRemove(key: string): Promise<void> {
  if (isSecureStoreNative()) {
    try {
      await rawSecureRemove(key);
    } catch {
      // Continue removing the compatibility mirror.
    }
  }
  await nativeRemove(key);
}

/**
 * Existing chunked secret API used by account snapshots. It remains
 * Keychain/Keystore-only and keeps its original key format for migration-free
 * continuity. New device-private records use the strict critical APIs above.
 */
export async function secureSetSecret(key: string, value: string): Promise<boolean> {
  if (!isSecureStoreNative()) return false;
  try {
    const chunks = value.match(new RegExp(`.{1,${SECRET_CHUNK_SIZE}}`, 'gs')) ?? [''];
    await SecureStoragePlugin.set({ key, value: chunks.length === 1 ? value : '' });
    await SecureStoragePlugin.set({ key: secretMetaKey(key), value: String(chunks.length) });
    await Promise.all(chunks.map((chunk, index) => SecureStoragePlugin.set({
      key: secretChunkKey(key, index),
      value: chunk,
    })));
    const readback = await secureGetSecret(key);
    return readback === value;
  } catch {
    return false;
  }
}

export async function secureGetSecret(key: string): Promise<string | null> {
  if (!isSecureStoreNative()) return null;
  try {
    const meta = await rawSecureGet(secretMetaKey(key));
    const chunkCount = Number(meta ?? 0);
    if (chunkCount > 1) {
      const chunks = await Promise.all(Array.from({ length: chunkCount }, (_, index) =>
        rawSecureGet(secretChunkKey(key, index)),
      ));
      if (chunks.some((chunk) => chunk === null)) return null;
      return chunks.join('');
    }
    return rawSecureGet(key);
  } catch {
    return null;
  }
}

export async function secureRemoveSecret(key: string): Promise<void> {
  if (!isSecureStoreNative()) return;
  let chunkCount = 0;
  try {
    chunkCount = Number(await rawSecureGet(secretMetaKey(key)) ?? 0);
  } catch {
    chunkCount = 0;
  }
  await Promise.allSettled([
    rawSecureRemove(key),
    rawSecureRemove(secretMetaKey(key)),
    ...Array.from({ length: chunkCount }, (_, index) =>
      rawSecureRemove(secretChunkKey(key, index)),
    ),
  ]);
}

export function isSecurePluginAvailable(): boolean | null {
  return isSecureStoreNative() ? true : false;
}

export type SecureStoreTier = 'keychain' | 'preferences' | 'web';

export interface SecureStoreHealth {
  tier: SecureStoreTier;
  pluginAvailable: boolean;
  probeRoundTripOk: boolean;
  driftedKeys: string[];
  reconciled: number;
  warnings: string[];
}

let healthCache: SecureStoreHealth | null = null;
let healthPromise: Promise<SecureStoreHealth> | null = null;

export async function verifySecureStoreHealth(watchedKeys: string[] = []): Promise<SecureStoreHealth> {
  if (healthCache) return healthCache;
  if (healthPromise) return healthPromise;

  healthPromise = (async () => {
    const driftedKeys: string[] = [];
    const warnings: string[] = [];
    let reconciled = 0;

    if (!isSecureStoreNative()) {
      healthCache = {
        tier: 'web',
        pluginAvailable: false,
        probeRoundTripOk: false,
        driftedKeys,
        reconciled,
        warnings,
      };
      return healthCache;
    }

    let probeRoundTripOk = false;
    try {
      const value = `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await SecureStoragePlugin.set({ key: PROBE_KEY, value });
      probeRoundTripOk = await rawSecureGet(PROBE_KEY) === value;
      await rawSecureRemove(PROBE_KEY);
    } catch (error) {
      warnings.push(`Keychain probe failed: ${errorMessage(error)}`);
    }

    if (probeRoundTripOk) {
      for (const key of watchedKeys) {
        try {
          const secureValue = await rawSecureGet(key);
          const mirror = nativeGetSync(key) ?? await nativeGet(key);
          if (secureValue !== null && secureValue !== mirror) {
            driftedKeys.push(key);
            await nativeSet(key, secureValue);
            reconciled += 1;
          } else if (secureValue === null && mirror !== null) {
            await SecureStoragePlugin.set({ key, value: mirror });
            reconciled += 1;
          }
        } catch (error) {
          warnings.push(`reconcile failed for ${key}: ${errorMessage(error)}`);
        }
      }
    }

    healthCache = {
      tier: probeRoundTripOk ? 'keychain' : 'preferences',
      pluginAvailable: probeRoundTripOk,
      probeRoundTripOk,
      driftedKeys,
      reconciled,
      warnings,
    };
    return healthCache;
  })();

  return healthPromise;
}

export function getSecureStoreHealth(): SecureStoreHealth | null {
  return healthCache;
}
