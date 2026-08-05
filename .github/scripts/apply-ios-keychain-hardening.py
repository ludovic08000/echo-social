from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")

def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")

def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one literal match, found {count}")
    write(path, text.replace(old, new, 1))

def regex_once(path: str, pattern: str, replacement: str, flags: int = 0) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"{path}: expected one regex match, found {count}: {pattern[:100]}")
    write(path, updated)

write("src/lib/secureStore.ts", r"""import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';

const PREFIX = 'forsure.secure.v1:';

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
  return Capacitor.isNativePlatform();
}

function namespacedKey(key: string): string {
  return `${PREFIX}${key}`;
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

export async function secureGetCriticalSecret(key: string): Promise<string | null> {
  if (!isSecureStoreNative()) return null;
  try {
    const result = await SecureStoragePlugin.get({ key: namespacedKey(key) });
    return typeof result?.value === 'string' ? result.value : null;
  } catch (error) {
    if (isMissingItemError(error)) return null;
    throw new NativeSecureStoreUnavailableError('get', error);
  }
}

export async function secureSetCriticalSecret(key: string, value: string): Promise<void> {
  if (!isSecureStoreNative()) {
    throw new NativeSecureStoreUnavailableError('set', 'native platform required');
  }
  try {
    await SecureStoragePlugin.set({ key: namespacedKey(key), value });
  } catch (error) {
    throw new NativeSecureStoreUnavailableError('set', error);
  }
  const readback = await secureGetCriticalSecret(key);
  if (readback !== value) {
    throw new NativeSecureStoreUnavailableError('set', 'keychain readback mismatch');
  }
}

export async function secureRemoveCriticalSecret(key: string): Promise<void> {
  if (!isSecureStoreNative()) {
    throw new NativeSecureStoreUnavailableError('remove', 'native platform required');
  }
  try {
    await SecureStoragePlugin.remove({ key: namespacedKey(key) });
  } catch (error) {
    if (!isMissingItemError(error)) {
      throw new NativeSecureStoreUnavailableError('remove', error);
    }
  }
  const readback = await secureGetCriticalSecret(key);
  if (readback !== null) {
    throw new NativeSecureStoreUnavailableError('remove', 'keychain delete readback mismatch');
  }
}

/**
 * Compatibility wrappers for non-critical callers. They intentionally never
 * fall back to Preferences/localStorage. Critical E2EE code must use the
 * throwing APIs above so native storage failures cannot be mistaken for a
 * missing key.
 */
export async function secureGetSecret(key: string): Promise<string | null> {
  try {
    return await secureGetCriticalSecret(key);
  } catch {
    return null;
  }
}

export async function secureSetSecret(key: string, value: string): Promise<boolean> {
  try {
    await secureSetCriticalSecret(key, value);
    return true;
  } catch {
    return false;
  }
}

export async function secureRemoveSecret(key: string): Promise<boolean> {
  try {
    await secureRemoveCriticalSecret(key);
    return true;
  } catch {
    return false;
  }
}
""")

write("src/lib/crypto/nativeKeyVault.ts", r"""import {
  isSecureStoreNative,
  secureGetCriticalSecret,
  secureRemoveCriticalSecret,
  secureSetCriticalSecret,
} from '@/lib/secureStore';

const VAULT_VERSION = 1 as const;
const KEY_PREFIX = 'aegis.native-key-vault.v1:';

interface NativeVaultEnvelope {
  version: typeof VAULT_VERSION;
  storageId: string;
  payload: unknown;
}

export class NativeKeyVaultCorruptError extends Error {
  constructor(storageId: string) {
    super(`E2EE_NATIVE_KEYCHAIN_CORRUPT:${storageId}`);
    this.name = 'NativeKeyVaultCorruptError';
  }
}

function key(storageId: string): string {
  return `${KEY_PREFIX}${storageId}`;
}

export async function readNativeKeyRecord<T>(
  storageId: string,
  validate: (value: unknown) => value is T,
): Promise<T | null> {
  if (!isSecureStoreNative()) return null;
  const encoded = await secureGetCriticalSecret(key(storageId));
  if (encoded === null) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    throw new NativeKeyVaultCorruptError(storageId);
  }

  const envelope = decoded as Partial<NativeVaultEnvelope> | null;
  if (
    !envelope ||
    envelope.version !== VAULT_VERSION ||
    envelope.storageId !== storageId ||
    !validate(envelope.payload)
  ) {
    throw new NativeKeyVaultCorruptError(storageId);
  }
  return envelope.payload;
}

export async function writeNativeKeyRecord<T>(
  storageId: string,
  payload: T,
): Promise<void> {
  if (!isSecureStoreNative()) return;
  const encoded = JSON.stringify({
    version: VAULT_VERSION,
    storageId,
    payload,
  } satisfies NativeVaultEnvelope);
  await secureSetCriticalSecret(key(storageId), encoded);
  const readback = await secureGetCriticalSecret(key(storageId));
  if (readback !== encoded) {
    throw new Error(`E2EE_NATIVE_KEYCHAIN_READBACK_FAILED:${storageId}`);
  }
}

export async function removeNativeKeyRecord(storageId: string): Promise<void> {
  if (!isSecureStoreNative()) return;
  await secureRemoveCriticalSecret(key(storageId));
}
""")

replace_once(
    "src/lib/crypto/deviceIdentity.ts",
    "import { getOrCreateDeviceKxKey, type DeviceKxKey } from './deviceKx';\n",
    "import { getOrCreateDeviceKxKey, type DeviceKxKey } from './deviceKx';\n"
    "import { isSecureStoreNative } from '@/lib/secureStore';\n"
    "import { readNativeKeyRecord, removeNativeKeyRecord, writeNativeKeyRecord } from './nativeKeyVault';\n",
)
replace_once(
    "src/lib/crypto/deviceIdentity.ts",
    "function storageKey(userId: string, deviceId: string): string {\n"
    "  return `device-signing::${userId}::${deviceId}`;\n"
    "}\n",
    "function storageKey(userId: string, deviceId: string): string {\n"
    "  return `device-signing::${userId}::${deviceId}`;\n"
    "}\n\n"
    "function isStoredDeviceIdentity(\n"
    "  value: unknown,\n"
    "  userId: string,\n"
    "  deviceId: string,\n"
    "): value is StoredDeviceIdentity {\n"
    "  const candidate = value as Partial<StoredDeviceIdentity> | null;\n"
    "  return Boolean(\n"
    "    candidate &&\n"
    "    candidate.id === storageKey(userId, deviceId) &&\n"
    "    candidate.userId === userId &&\n"
    "    candidate.deviceId === deviceId &&\n"
    "    candidate.publicKeyJWK && typeof candidate.publicKeyJWK === 'object' &&\n"
    "    candidate.privateKeyJWK && typeof candidate.privateKeyJWK === 'object' &&\n"
    "    typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)\n"
    "  );\n"
    "}\n\n"
    "async function loadStoredDeviceIdentity(\n"
    "  userId: string,\n"
    "  deviceId: string,\n"
    "): Promise<StoredDeviceIdentity | null> {\n"
    "  const id = storageKey(userId, deviceId);\n"
    "  if (isSecureStoreNative()) {\n"
    "    const native = await readNativeKeyRecord(id, (value): value is StoredDeviceIdentity =>\n"
    "      isStoredDeviceIdentity(value, userId, deviceId));\n"
    "    if (native) {\n"
    "      await dbPut(native).catch(() => undefined);\n"
    "      return native;\n"
    "    }\n"
    "    const legacy = await dbGet<StoredDeviceIdentity>(id);\n"
    "    if (!legacy) return null;\n"
    "    if (!isStoredDeviceIdentity(legacy, userId, deviceId)) {\n"
    "      throw new Error('E2EE_DEVICE_SIGNING_RECORD_INVALID');\n"
    "    }\n"
    "    await writeNativeKeyRecord(id, legacy);\n"
    "    return legacy;\n"
    "  }\n"
    "  const stored = await dbGet<StoredDeviceIdentity>(id);\n"
    "  if (!stored) return null;\n"
    "  if (!isStoredDeviceIdentity(stored, userId, deviceId)) {\n"
    "    throw new Error('E2EE_DEVICE_SIGNING_RECORD_INVALID');\n"
    "  }\n"
    "  return stored;\n"
    "}\n\n"
    "async function persistStoredDeviceIdentity(record: StoredDeviceIdentity): Promise<void> {\n"
    "  if (isSecureStoreNative()) {\n"
    "    await writeNativeKeyRecord(record.id, record);\n"
    "    await dbPut(record).catch(() => undefined);\n"
    "    return;\n"
    "  }\n"
    "  await dbPut(record);\n"
    "}\n",
)
regex_once(
    "src/lib/crypto/deviceIdentity.ts",
    r"export async function loadDeviceIdentity\(\n  userId: string,\n  deviceId: string,\n\): Promise<DeviceIdentityKey \| null> \{\n  const stored = await dbGet<StoredDeviceIdentity>\(storageKey\(userId, deviceId\)\);\n  if \(!stored\) return null;\n",
    "export async function loadDeviceIdentity(\n"
    "  userId: string,\n"
    "  deviceId: string,\n"
    "): Promise<DeviceIdentityKey | null> {\n"
    "  const stored = await loadStoredDeviceIdentity(userId, deviceId);\n"
    "  if (!stored) return null;\n",
)
replace_once(
    "src/lib/crypto/deviceIdentity.ts",
    "    await dbPut<StoredDeviceIdentity>({\n"
    "      id,\n"
    "      userId,\n"
    "      deviceId,\n"
    "      publicKeyJWK,\n"
    "      privateKeyJWK,\n"
    "      createdAt: Date.now(),\n"
    "    });\n",
    "    await persistStoredDeviceIdentity({\n"
    "      id,\n"
    "      userId,\n"
    "      deviceId,\n"
    "      publicKeyJWK,\n"
    "      privateKeyJWK,\n"
    "      createdAt: Date.now(),\n"
    "    });\n",
)
replace_once(
    "src/lib/crypto/deviceIdentity.ts",
    "export async function deleteDeviceIdentity(userId: string, deviceId: string): Promise<void> {\n"
    "  creationJobs.delete(storageKey(userId, deviceId));\n"
    "  try {\n"
    "    await dbDelete(storageKey(userId, deviceId));\n"
    "  } catch {\n"
    "    // Failure cleanup is best-effort; never rotate an established device here.\n"
    "  }\n"
    "}\n",
    "export async function deleteDeviceIdentity(userId: string, deviceId: string): Promise<void> {\n"
    "  const id = storageKey(userId, deviceId);\n"
    "  creationJobs.delete(id);\n"
    "  await Promise.allSettled([\n"
    "    dbDelete(id),\n"
    "    removeNativeKeyRecord(id),\n"
    "  ]);\n"
    "}\n",
)

replace_once(
    "src/lib/crypto/deviceKx.ts",
    "import { runCrossTabExclusive } from './crossTabLock';\n",
    "import { runCrossTabExclusive } from './crossTabLock';\n"
    "import { isSecureStoreNative } from '@/lib/secureStore';\n"
    "import { readNativeKeyRecord, removeNativeKeyRecord, writeNativeKeyRecord } from './nativeKeyVault';\n",
)
replace_once(
    "src/lib/crypto/deviceKx.ts",
    "function storageKey(deviceId: string, userId: string): string {\n"
    "  return `device-kx::${userId}::${deviceId}`;\n"
    "}\n",
    "function storageKey(deviceId: string, userId: string): string {\n"
    "  return `device-kx::${userId}::${deviceId}`;\n"
    "}\n\n"
    "function isStoredDeviceKx(value: unknown, deviceId: string, userId: string): value is StoredDeviceKx {\n"
    "  const candidate = value as Partial<StoredDeviceKx> | null;\n"
    "  return Boolean(\n"
    "    candidate &&\n"
    "    candidate.id === storageKey(deviceId, userId) &&\n"
    "    candidate.userId === userId &&\n"
    "    candidate.deviceId === deviceId &&\n"
    "    candidate.publicKeyJWK && typeof candidate.publicKeyJWK === 'object' &&\n"
    "    candidate.privateKeyJWK && typeof candidate.privateKeyJWK === 'object' &&\n"
    "    typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)\n"
    "  );\n"
    "}\n\n"
    "async function loadStoredDeviceKx(deviceId: string, userId: string): Promise<StoredDeviceKx | null> {\n"
    "  const id = storageKey(deviceId, userId);\n"
    "  if (isSecureStoreNative()) {\n"
    "    const native = await readNativeKeyRecord(id, (value): value is StoredDeviceKx =>\n"
    "      isStoredDeviceKx(value, deviceId, userId));\n"
    "    if (native) {\n"
    "      await dbPut(native).catch(() => undefined);\n"
    "      return native;\n"
    "    }\n"
    "    const legacy = await dbGet<StoredDeviceKx>(id);\n"
    "    if (!legacy) return null;\n"
    "    if (!isStoredDeviceKx(legacy, deviceId, userId)) {\n"
    "      throw new Error('E2EE_DEVICE_KX_RECORD_INVALID');\n"
    "    }\n"
    "    await writeNativeKeyRecord(id, legacy);\n"
    "    return legacy;\n"
    "  }\n"
    "  const stored = await dbGet<StoredDeviceKx>(id);\n"
    "  if (!stored) return null;\n"
    "  if (!isStoredDeviceKx(stored, deviceId, userId)) {\n"
    "    throw new Error('E2EE_DEVICE_KX_RECORD_INVALID');\n"
    "  }\n"
    "  return stored;\n"
    "}\n\n"
    "async function persistStoredDeviceKx(record: StoredDeviceKx): Promise<void> {\n"
    "  if (isSecureStoreNative()) {\n"
    "    await writeNativeKeyRecord(record.id, record);\n"
    "    await dbPut(record).catch(() => undefined);\n"
    "    return;\n"
    "  }\n"
    "  await dbPut(record);\n"
    "}\n",
)
replace_once(
    "src/lib/crypto/deviceKx.ts",
    "  const stored = await dbGet<StoredDeviceKx>(storageKey(deviceId, userId));\n"
    "  return stored ? importStoredDeviceKx(stored) : null;\n",
    "  const stored = await loadStoredDeviceKx(deviceId, userId);\n"
    "  return stored ? importStoredDeviceKx(stored) : null;\n",
)
replace_once(
    "src/lib/crypto/deviceKx.ts",
    "  await dbPut<StoredDeviceKx>({\n"
    "    id: storageKey(deviceId, userId),\n"
    "    userId,\n"
    "    deviceId,\n"
    "    publicKeyJWK,\n"
    "    privateKeyJWK,\n"
    "    createdAt: Date.now(),\n"
    "  });\n",
    "  await persistStoredDeviceKx({\n"
    "    id: storageKey(deviceId, userId),\n"
    "    userId,\n"
    "    deviceId,\n"
    "    publicKeyJWK,\n"
    "    privateKeyJWK,\n"
    "    createdAt: Date.now(),\n"
    "  });\n",
)
replace_once(
    "src/lib/crypto/deviceKx.ts",
    "export async function deleteDeviceKxKey(deviceId: string, userId: string): Promise<void> {\n"
    "  try {\n"
    "    await dbDelete(storageKey(deviceId, userId));\n"
    "  } catch {\n"
    "    /* non-fatal */\n"
    "  }\n"
    "}\n",
    "export async function deleteDeviceKxKey(deviceId: string, userId: string): Promise<void> {\n"
    "  const id = storageKey(deviceId, userId);\n"
    "  creationJobs.delete(id);\n"
    "  await Promise.allSettled([\n"
    "    dbDelete(id),\n"
    "    removeNativeKeyRecord(id),\n"
    "  ]);\n"
    "}\n",
)

replace_once(
    "src/lib/crypto/x3dh.ts",
    "import { fetchVerifiedDeviceIdentity } from './signedDeviceList';\n",
    "import { fetchVerifiedDeviceIdentity } from './signedDeviceList';\n"
    "import { isSecureStoreNative } from '@/lib/secureStore';\n"
    "import { readNativeKeyRecord, removeNativeKeyRecord, writeNativeKeyRecord } from './nativeKeyVault';\n",
)
replace_once(
    "src/lib/crypto/x3dh.ts",
    "export type DevicePrekeyBundleErrorCode =\n"
    "  | 'DEVICE_PREKEY_BUNDLE_UNAVAILABLE'\n"
    "  | 'DEVICE_SPK_SIGNATURE_INVALID'\n"
    "  | 'ACCOUNT_IDENTITY_BINDING_INVALID';\n",
    "export type DevicePrekeyBundleErrorCode =\n"
    "  | 'DEVICE_PREKEY_BUNDLE_UNAVAILABLE'\n"
    "  | 'DEVICE_PREKEY_BUNDLE_FETCH_FAILED'\n"
    "  | 'DEVICE_SIGNED_PREKEY_UNAVAILABLE'\n"
    "  | 'DEVICE_SPK_SIGNATURE_INVALID'\n"
    "  | 'ACCOUNT_IDENTITY_BINDING_INVALID';\n",
)
replace_once(
    "src/lib/crypto/x3dh.ts",
    "function deviceSpkKey(userId: string, deviceId: string, spkId: number): string { return `${userId}::dev::${deviceId}::${spkId}`; }\n"
    "function deviceOPKKey(userId: string, deviceId: string, opkId: number): string { return `${userId}::dev::${deviceId}::opk::${opkId}`; }\n",
    "function deviceSpkKey(userId: string, deviceId: string, spkId: number): string { return `${userId}::dev::${deviceId}::${spkId}`; }\n"
    "function deviceOPKKey(userId: string, deviceId: string, opkId: number): string { return `${userId}::dev::${deviceId}::opk::${opkId}`; }\n"
    "function nativePrekeyKey(id: string): string { return `x3dh-prekey::${id}`; }\n\n"
    "function isStoredPrekey(value: unknown, id: string): value is StoredSPK {\n"
    "  const candidate = value as Partial<StoredSPK> | null;\n"
    "  return Boolean(\n"
    "    candidate &&\n"
    "    candidate.id === id &&\n"
    "    typeof candidate.spkId === 'number' && Number.isInteger(candidate.spkId) && candidate.spkId > 0 &&\n"
    "    candidate.privateKeyJWK && typeof candidate.privateKeyJWK === 'object' &&\n"
    "    typeof candidate.publicKeyBase64 === 'string' && candidate.publicKeyBase64.length >= 40 &&\n"
    "    typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)\n"
    "  );\n"
    "}\n\n"
    "async function persistStoredPrekey(record: StoredSPK): Promise<void> {\n"
    "  if (isSecureStoreNative()) {\n"
    "    await writeNativeKeyRecord(nativePrekeyKey(record.id), record);\n"
    "    await runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => {\n"
    "      tx.objectStore(SPK_STORE).put(record);\n"
    "    }).catch(() => undefined);\n"
    "    return;\n"
    "  }\n"
    "  await runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => {\n"
    "    tx.objectStore(SPK_STORE).put(record);\n"
    "  });\n"
    "}\n\n"
    "async function loadStoredPrekey(id: string): Promise<StoredSPK | null> {\n"
    "  if (isSecureStoreNative()) {\n"
    "    const native = await readNativeKeyRecord(nativePrekeyKey(id), (value): value is StoredSPK =>\n"
    "      isStoredPrekey(value, id));\n"
    "    if (native) {\n"
    "      await runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => {\n"
    "        tx.objectStore(SPK_STORE).put(native);\n"
    "      }).catch(() => undefined);\n"
    "      return native;\n"
    "    }\n"
    "    const legacy = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) =>\n"
    "      reqToPromise<StoredSPK | undefined>(tx.objectStore(SPK_STORE).get(id)),\n"
    "    ).catch(() => undefined);\n"
    "    if (!legacy) return null;\n"
    "    if (!isStoredPrekey(legacy, id)) throw new Error('E2EE_PREKEY_RECORD_INVALID');\n"
    "    await writeNativeKeyRecord(nativePrekeyKey(id), legacy);\n"
    "    return legacy;\n"
    "  }\n"
    "  const stored = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) =>\n"
    "    reqToPromise<StoredSPK | undefined>(tx.objectStore(SPK_STORE).get(id)),\n"
    "  ).catch(() => undefined);\n"
    "  if (!stored) return null;\n"
    "  if (!isStoredPrekey(stored, id)) throw new Error('E2EE_PREKEY_RECORD_INVALID');\n"
    "  return stored;\n"
    "}\n\n"
    "async function deleteStoredPrekey(id: string): Promise<void> {\n"
    "  await Promise.allSettled([\n"
    "    runTxOn('spk', [SPK_STORE], 'readwrite', (tx) => {\n"
    "      tx.objectStore(SPK_STORE).delete(id);\n"
    "    }),\n"
    "    removeNativeKeyRecord(nativePrekeyKey(id)),\n"
    "  ]);\n"
    "}\n",
)
regex_once(
    "src/lib/crypto/x3dh.ts",
    r"async function saveDeviceSPKPrivate\(userId: string, deviceId: string, spkId: number, privateKey: CryptoKey, publicBase64: string\): Promise<void> \{.*?\n\}\n\nasync function loadDeviceSPKRecord\(userId: string, deviceId: string, spkId: number\): Promise<StoredSPK \| null> \{.*?\n\}\n\nasync function deleteDeviceSPKPrivate\(userId: string, deviceId: string, spkId: number\): Promise<void> \{.*?\n\}\n",
    "async function saveDeviceSPKPrivate(userId: string, deviceId: string, spkId: number, privateKey: CryptoKey, publicBase64: string): Promise<void> {\n"
    "  const jwk = await hardCrypto.exportKey('jwk', privateKey);\n"
    "  await persistStoredPrekey({\n"
    "    id: deviceSpkKey(userId, deviceId, spkId),\n"
    "    spkId,\n"
    "    privateKeyJWK: jwk,\n"
    "    publicKeyBase64: publicBase64,\n"
    "    createdAt: Date.now(),\n"
    "  });\n"
    "}\n\n"
    "async function loadDeviceSPKRecord(userId: string, deviceId: string, spkId: number): Promise<StoredSPK | null> {\n"
    "  return loadStoredPrekey(deviceSpkKey(userId, deviceId, spkId));\n"
    "}\n\n"
    "async function deleteDeviceSPKPrivate(userId: string, deviceId: string, spkId: number): Promise<void> {\n"
    "  await deleteStoredPrekey(deviceSpkKey(userId, deviceId, spkId));\n"
    "}\n",
    flags=re.S,
)
regex_once(
    "src/lib/crypto/x3dh.ts",
    r"async function pruneOldDeviceSPKs\(userId: string, deviceId: string, activeSpkId: number\): Promise<void> \{.*?\n\}\n\nexport async function generateAndUploadDeviceSignedPrekey",
    "async function pruneOldDeviceSPKs(userId: string, deviceId: string, activeSpkId: number): Promise<void> {\n"
    "  const prefix = `${userId}::dev::${deviceId}::`;\n"
    "  const now = Date.now();\n"
    "  const maxAgeMs = 45 * 24 * 60 * 60 * 1000;\n"
    "  const records = await runTxOn('spk', [SPK_STORE], 'readonly', (tx) =>\n"
    "    reqToPromise<StoredSPK[]>(tx.objectStore(SPK_STORE).getAll()),\n"
    "  ).catch(() => [] as StoredSPK[]);\n"
    "  const stale = records\n"
    "    .filter((record) => record.id.startsWith(prefix) && !record.id.includes('::opk::'))\n"
    "    .sort((a, b) => b.createdAt - a.createdAt)\n"
    "    .filter((record, index) =>\n"
    "      record.spkId !== activeSpkId && (index >= 4 || now - record.createdAt > maxAgeMs));\n"
    "  await Promise.all(stale.map((record) => deleteStoredPrekey(record.id)));\n"
    "}\n\n"
    "export async function generateAndUploadDeviceSignedPrekey",
    flags=re.S,
)
regex_once(
    "src/lib/crypto/x3dh.ts",
    r"async function saveDeviceOPKPrivate\(userId: string, deviceId: string, opkId: number, privateKey: CryptoKey, publicBase64: string\): Promise<void> \{.*?\n\}\n\nasync function loadDeviceOPKPrivate\(userId: string, deviceId: string, opkId: number\): Promise<CryptoKey \| null> \{.*?\n\}\n\nasync function deleteDeviceOPKPrivate\(userId: string, deviceId: string, opkId: number\): Promise<void> \{.*?\n\}\n",
    "async function saveDeviceOPKPrivate(userId: string, deviceId: string, opkId: number, privateKey: CryptoKey, publicBase64: string): Promise<void> {\n"
    "  const jwk = await hardCrypto.exportKey('jwk', privateKey);\n"
    "  await persistStoredPrekey({\n"
    "    id: deviceOPKKey(userId, deviceId, opkId),\n"
    "    spkId: opkId,\n"
    "    privateKeyJWK: jwk,\n"
    "    publicKeyBase64: publicBase64,\n"
    "    createdAt: Date.now(),\n"
    "  });\n"
    "}\n\n"
    "async function loadDeviceOPKPrivate(userId: string, deviceId: string, opkId: number): Promise<CryptoKey | null> {\n"
    "  const result = await loadStoredPrekey(deviceOPKKey(userId, deviceId, opkId));\n"
    "  if (!result) return null;\n"
    "  return importKeyFromJWK(result.privateKeyJWK, KX_KEY_PARAMS, ['deriveBits'], false);\n"
    "}\n\n"
    "async function deleteDeviceOPKPrivate(userId: string, deviceId: string, opkId: number): Promise<void> {\n"
    "  await deleteStoredPrekey(deviceOPKKey(userId, deviceId, opkId));\n"
    "}\n",
    flags=re.S,
)
regex_once(
    "src/lib/crypto/x3dh.ts",
    r"async function fetchDevicePrekeyMaterial\(\n  peerUserId: string,\n  peerDeviceId: string,\n\): Promise<\{ identityKey: string; signingKey: string; spkId: number; publicKey: string; signature: string \} \| null> \{.*?\n\}\n\nfunction safeBase64BytesLength",
    "async function fetchDevicePrekeyMaterial(\n"
    "  peerUserId: string,\n"
    "  peerDeviceId: string,\n"
    "): Promise<{ identityKey: string; signingKey: string; spkId: number; publicKey: string; signature: string }> {\n"
    "  const device = await fetchVerifiedDeviceIdentity(peerUserId, peerDeviceId);\n"
    "  if (!device) {\n"
    "    throw new DevicePrekeyBundleError(\n"
    "      'ACCOUNT_IDENTITY_BINDING_INVALID',\n"
    "      peerUserId,\n"
    "      peerDeviceId,\n"
    "    );\n"
    "  }\n"
    "  const { data: spkRows, error } = await (supabase as any).rpc('get_device_prekey_bundle', {\n"
    "    p_user_id: peerUserId,\n"
    "    p_device_id: peerDeviceId,\n"
    "  });\n"
    "  if (error) {\n"
    "    throw new DevicePrekeyBundleError(\n"
    "      'DEVICE_PREKEY_BUNDLE_FETCH_FAILED',\n"
    "      peerUserId,\n"
    "      peerDeviceId,\n"
    "    );\n"
    "  }\n"
    "  if (!spkRows || spkRows.length === 0) {\n"
    "    throw new DevicePrekeyBundleError(\n"
    "      'DEVICE_SIGNED_PREKEY_UNAVAILABLE',\n"
    "      peerUserId,\n"
    "      peerDeviceId,\n"
    "    );\n"
    "  }\n"
    "  const spk = spkRows[0] as { spk_id: number; public_key: string; signature: string };\n"
    "  return {\n"
    "    identityKey: device.devicePublicKey,\n"
    "    signingKey: device.deviceSigningKey,\n"
    "    spkId: Number(spk.spk_id),\n"
    "    publicKey: spk.public_key,\n"
    "    signature: spk.signature,\n"
    "  };\n"
    "}\n\n"
    "function safeBase64BytesLength",
    flags=re.S,
)
replace_once(
    "src/lib/crypto/x3dh.ts",
    "  const material = await fetchDevicePrekeyMaterial(peerUserId, peerDeviceId);\n"
    "  if (!material) return null;\n"
    "  const sigValid = await verifySignedPrekey(material.signingKey, material.publicKey, material.signature, { source: 'peekDeviceSignedPrekey'",
    "  const material = await fetchDevicePrekeyMaterial(peerUserId, peerDeviceId);\n"
    "  const sigValid = await verifySignedPrekey(material.signingKey, material.publicKey, material.signature, { source: 'peekDeviceSignedPrekey'",
)
replace_once(
    "src/lib/crypto/x3dh.ts",
    "  const material = await fetchDevicePrekeyMaterial(peerUserId, peerDeviceId);\n"
    "  if (!material) return null;\n"
    "  const sigValid = await verifySignedPrekey(material.signingKey, material.publicKey, material.signature, { source: 'fetchPrekeyBundleForDevice'",
    "  const material = await fetchDevicePrekeyMaterial(peerUserId, peerDeviceId);\n"
    "  const sigValid = await verifySignedPrekey(material.signingKey, material.publicKey, material.signature, { source: 'fetchPrekeyBundleForDevice'",
)

replace_once(
    "src/lib/crypto/resyncE2EE.ts",
    "  try {\n"
    "    await refreshDeviceSignedPrekeyIfNeeded(userId, deviceId, authorization.deviceSigning.privateKey);\n"
    "    result.spk = true;\n"
    "  } catch (e) {\n"
    "    console.warn('[resync] device SPK refresh failed:', e);\n"
    "  }\n",
    "  try {\n"
    "    await refreshDeviceSignedPrekeyIfNeeded(userId, deviceId, authorization.deviceSigning.privateKey);\n"
    "    result.spk = true;\n"
    "  } catch (e) {\n"
    "    result.spk = false;\n"
    "    logCryptoException('restore', e, {\n"
    "      severity: 'error',\n"
    "      myDeviceId: deviceId,\n"
    "      metadata: {\n"
    "        stage: 'device_signed_prekey_publish',\n"
    "        errorCode: 'E2EE_DEVICE_SPK_PUBLISH_FAILED',\n"
    "      },\n"
    "    });\n"
    "    throw new Error('E2EE_DEVICE_SPK_PUBLISH_FAILED', { cause: e });\n"
    "  }\n",
)

write("supabase/migrations/20260805164500_require_active_spk_for_device_routing.sql", r"""begin;

create or replace function public.get_sesame_device_list(p_user_id uuid)
returns table (
  device_id text,
  device_public_key text,
  device_signing_key text,
  device_authorization_signature text,
  last_seen_at timestamptz,
  account_identity_key text,
  account_signing_key text,
  account_fingerprint text,
  account_binding_signature text,
  account_binding_version integer,
  is_routable boolean,
  revoked_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select
    device.device_id,
    device.device_public_key,
    device.device_signing_key,
    device.device_authorization_signature,
    device.last_seen_at,
    account.identity_key,
    account.signing_key,
    account.fingerprint,
    account.identity_binding_signature,
    account.identity_binding_version,
    (
      device.is_active = true
      and coalesce(device.approval_status, 'approved') = 'approved'
      and device.revoked_at is null
      and device.crypto_invalid_at is null
      and exists (
        select 1
        from public.device_signed_prekeys spk
        where spk.user_id = device.user_id
          and spk.device_id = device.device_id
          and spk.is_active = true
          and (spk.expires_at is null or spk.expires_at > now())
      )
    ) as is_routable,
    device.revoked_at
  from public.user_devices device
  join public.user_public_keys account
    on account.user_id = device.user_id
   and account.is_active = true
  where device.user_id = p_user_id
    and nullif(trim(device.device_public_key), '') is not null
    and nullif(trim(device.device_signing_key), '') is not null
    and nullif(trim(device.device_authorization_signature), '') is not null
    and nullif(trim(account.identity_key), '') is not null
    and nullif(trim(account.signing_key), '') is not null
    and nullif(trim(account.fingerprint), '') is not null
    and account.identity_binding_version = 1
    and nullif(trim(account.identity_binding_signature), '') is not null
  order by device.device_id;
$function$;

update public.user_devices device
set routing_status = case
      when exists (
        select 1
        from public.device_signed_prekeys spk
        where spk.user_id = device.user_id
          and spk.device_id = device.device_id
          and spk.is_active = true
          and (spk.expires_at is null or spk.expires_at > now())
      ) then 'ready'
      else 'repairing'
    end,
    routing_error = case
      when exists (
        select 1
        from public.device_signed_prekeys spk
        where spk.user_id = device.user_id
          and spk.device_id = device.device_id
          and spk.is_active = true
          and (spk.expires_at is null or spk.expires_at > now())
      ) then null
      else 'SIGNED_PREKEY_REQUIRED'
    end,
    routing_checked_at = now(),
    updated_at = now()
where device.revoked_at is null
  and device.crypto_invalid_at is null
  and coalesce(device.approval_status, 'approved') <> 'rejected';

notify pgrst, 'reload schema';

commit;
""")

write("src/lib/crypto/__tests__/iosNativeKeyVault.test.ts", r"""import { beforeEach, describe, expect, it, vi } from 'vitest';

let native = true;
let unavailable = false;
const secrets = new Map<string, string>();

vi.mock('@/lib/secureStore', () => ({
  isSecureStoreNative: () => native,
  secureGetCriticalSecret: async (key: string) => {
    if (unavailable) throw new Error('E2EE_NATIVE_KEYCHAIN_UNAVAILABLE:get');
    return secrets.get(key) ?? null;
  },
  secureSetCriticalSecret: async (key: string, value: string) => {
    if (unavailable) throw new Error('E2EE_NATIVE_KEYCHAIN_UNAVAILABLE:set');
    secrets.set(key, value);
  },
  secureRemoveCriticalSecret: async (key: string) => {
    if (unavailable) throw new Error('E2EE_NATIVE_KEYCHAIN_UNAVAILABLE:remove');
    secrets.delete(key);
  },
}));

import {
  NativeKeyVaultCorruptError,
  readNativeKeyRecord,
  removeNativeKeyRecord,
  writeNativeKeyRecord,
} from '@/lib/crypto/nativeKeyVault';

interface RecordValue {
  id: string;
  value: number;
}

const validate = (value: unknown): value is RecordValue => {
  const candidate = value as Partial<RecordValue> | null;
  return Boolean(candidate && candidate.id === 'device' && candidate.value === 7);
};

describe('iOS native key vault', () => {
  beforeEach(() => {
    native = true;
    unavailable = false;
    secrets.clear();
  });

  it('performs a native write/read/delete roundtrip', async () => {
    await writeNativeKeyRecord('record', { id: 'device', value: 7 });
    await expect(readNativeKeyRecord('record', validate)).resolves.toEqual({ id: 'device', value: 7 });
    await removeNativeKeyRecord('record');
    await expect(readNativeKeyRecord('record', validate)).resolves.toBeNull();
  });

  it('fails closed when native secure storage is unavailable', async () => {
    unavailable = true;
    await expect(writeNativeKeyRecord('record', { id: 'device', value: 7 }))
      .rejects.toThrow('E2EE_NATIVE_KEYCHAIN_UNAVAILABLE');
  });

  it('rejects a corrupted or cross-bound record', async () => {
    secrets.set('aegis.native-key-vault.v1:record', JSON.stringify({
      version: 1,
      storageId: 'another-record',
      payload: { id: 'device', value: 7 },
    }));
    await expect(readNativeKeyRecord('record', validate))
      .rejects.toBeInstanceOf(NativeKeyVaultCorruptError);
  });

  it('does not touch native storage on the web', async () => {
    native = false;
    await writeNativeKeyRecord('record', { id: 'device', value: 7 });
    expect(secrets.size).toBe(0);
    await expect(readNativeKeyRecord('record', validate)).resolves.toBeNull();
  });
});
""")

write("src/lib/crypto/__tests__/iosDeviceRoutingMigration.test.ts", r"""import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260805164500_require_active_spk_for_device_routing.sql',
  'utf8',
).toLowerCase();

describe('iOS device routing hardening migration', () => {
  it('requires an active non-expired signed prekey for routability', () => {
    expect(migration).toContain('device.crypto_invalid_at is null');
    expect(migration).toContain('from public.device_signed_prekeys spk');
    expect(migration).toContain('spk.is_active = true');
    expect(migration).toContain('spk.expires_at is null or spk.expires_at > now()');
  });

  it('keeps devices without a signed prekey in repairing state', () => {
    expect(migration).toContain("else 'repairing'");
    expect(migration).toContain("else 'signed_prekey_required'");
  });
});
""")

print("iOS keychain/routing hardening patch applied")
