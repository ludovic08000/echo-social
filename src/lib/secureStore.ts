/**
 * Aegis secure storage router.
 *
 * - Native iOS: AegisKeychain backed by the Secure Enclave anchor.
 * - Native Android: AegisKeychain backed by a non-exportable Android Keystore key.
 * - Web browsers: ACE Web, a software enclave using a non-extractable
 *   WebCrypto AES-GCM anchor and authenticated records in IndexedDB.
 *
 * ACE Web is not a hardware boundary: same-origin script execution can invoke
 * WebCrypto. It does prevent private material from being stored as plaintext in
 * localStorage/Preferences and fails closed if the IndexedDB anchor disappears.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import { nativeGet, nativeGetSync, nativeRemove, nativeSet } from '@/lib/nativeStore';
import { isVerifiedNativeRuntime } from '@/lib/runtimePlatform';
import {
  verifyWebAegisEnclaveHealth,
  webAegisEnclaveGet,
  webAegisEnclaveRemove,
  webAegisEnclaveSet,
} from '@/lib/crypto/webAegisEnclave';

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
  const platform = Capacitor.getPlatform();
  return isSecureStoreNative() && (platform === 'ios' || platform === 'android');
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

/** ACE hardware on native; ACE Web on browsers. Never Preferences/localStorage. */
export async function secureGetCriticalSecret(key: string): Promise<string | null> {
  const scopedKey = criticalKey(key);
  if (!isSecureStoreNative()) return webAegisEnclaveGet(scopedKey);
  try {
    return await criticalPlatformGet(scopedKey);
  } catch (error) {
    throw new NativeSecureStoreUnavailableError('get', error);
  }
}

/** Critical write with mandatory authenticated readback on every platform. */
export async function secureSetCriticalSecret(key: string, value: string): Promise<void> {
  const scopedKey = criticalKey(key);
  if (!isSecureStoreNative()) {
    await webAegisEnclaveSet(scopedKey, value);
    const readback = await webAegisEnclaveGet(scopedKey);
    if (readback !== value) throw new Error('E2EE_WEB_ENCLAVE_READBACK_MISMATCH');
    return;
  }

  try {
    await criticalPlatformSet(scopedKey, value);
  } catch (error) {
    throw new NativeSecureStoreUnavailableError('set', error);
  }
  const readback = await secureGetCriticalSecret(key);
  if (readback !== value) {
    throw new NativeSecureStoreUnavailableError('set', 'keychain readback mismatch');
  }
}

/** Critical deletion with mandatory readback on every platform. */
export async function secureRemoveCriticalSecret(key: string): Promise<void> {
  const scopedKey = criticalKey(key);
  if (!isSecureStoreNative()) {
    await webAegisEnclaveRemove(scopedKey);
    if (await webAegisEnclaveGet(scopedKey) !== null) {
      throw new Error('E2EE_WEB_ENCLAVE_DELETE_READBACK_MISMATCH');
    }
    return;
  }

  try {
    await criticalPlatformRemove(scopedKey);
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
 * Snapshot storage. Native keeps the established chunked Keychain format.
 * Chrome stores the complete snapshot as one authenticated ACE Web record.
 */
export async function secureSetSecret(key: string, value: string): Promise<boolean> {
  if (!isSecureStoreNative()) {
    try {
      await webAegisEnclaveSet(key, value);
      return await webAegisEnclaveGet(key) === value;
    } catch {
      return false;
    }
  }

  // Invariant ACE : sur iOS le snapshot X3DH + sessions est un unique
  // enregistrement authentifié. Le découpage Keychain générique pourrait
  // exposer un mélange ancien/nouveau après une interruption entre chunks.
  if (isIOSNative()) {
    try {
      await AegisKeychain.set({ key, value });
      const result = await AegisKeychain.get({ key });
      return result?.value === value;
    } catch {
      return false;
    }
  }

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
  if (!isSecureStoreNative()) return webAegisEnclaveGet(key);

  if (isIOSNative()) {
    try {
      const result = await AegisKeychain.get({ key });
      return typeof result?.value === 'string' ? result.value : null;
    } catch {
      return null;
    }
  }

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
  if (!isSecureStoreNative()) {
    await webAegisEnclaveRemove(key);
    return;
  }

  if (isIOSNative()) {
    await AegisKeychain.remove({ key });
    const result = await AegisKeychain.get({ key });
    if (result?.value != null) throw new Error('E2EE_ENCLAVE_DELETE_READBACK_MISMATCH');
    return;
  }

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

export type SecureStoreTier = 'keychain' | 'preferences' | 'web-enclave' | 'web';

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
      const webHealth = await verifyWebAegisEnclaveHealth();
      if (webHealth.warning) warnings.push(webHealth.warning);
      if (webHealth.persistentStorage === false) {
        warnings.push('Browser storage persistence was not granted; recovery backup remains required.');
      }
      healthCache = {
        tier: webHealth.available && webHealth.roundTripOk ? 'web-enclave' : 'web',
        pluginAvailable: false,
        probeRoundTripOk: webHealth.roundTripOk,
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
