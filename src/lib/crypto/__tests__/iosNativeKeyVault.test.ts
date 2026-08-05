import { beforeEach, describe, expect, it, vi } from 'vitest';

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
