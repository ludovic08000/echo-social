import {
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
