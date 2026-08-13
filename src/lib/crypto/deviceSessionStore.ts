/**
 * Durable Signal-style session store shared by Windows, iOS and Android.
 *
 * iOS Web/PWA stores ratchet material only in ACE. Native iOS/Android stores
 * it in the platform key vault and retains the IndexedDB compatibility mirror.
 * Windows keeps its established IndexedDB path. All sealed writes are read
 * back by DeviceVault before this module reports success.
 */
import {
  adoptLegacyPlaintextRecord,
  deviceVaultMirrorsPlaintext,
  listDeviceVaultStorageIds,
  readDeviceVaultRecord,
  removeDeviceVaultRecord,
  writeDeviceVaultRecord,
} from './deviceVault';
import { reqToPromise, runTxOn } from './indexedDbTx';

export type DeviceSessionStoreName = 'sessions' | 'initiating-sessions';

export interface DeviceSessionSnapshot {
  sessions: Array<{ id: string } & Record<string, unknown>>;
  initiating: Array<{ id: string } & Record<string, unknown>>;
}

const backupTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleEncryptedSessionBackup(recordId: string): void {
  if (typeof navigator === 'undefined' || !/(Windows|iPhone|iPad|iPod)/i.test(navigator.userAgent || '')) return;
  const parts = recordId.split('::');
  if (parts.length < 2) return;
  const [userId, deviceId] = parts;
  if (!userId || !deviceId) return;
  const key = `${userId}:${deviceId}`;
  const prior = backupTimers.get(key);
  if (prior) clearTimeout(prior);
  backupTimers.set(key, setTimeout(() => {
    backupTimers.delete(key);
    void (async () => {
      const { backupIosDeviceVaultIfReady } = await import('@/platforms/ios/iosDeviceVaultRestore');
      if (await backupIosDeviceVaultIfReady(userId)) return;
      const { backupWindowsHelloDeviceVaultIfReady } = await import('./windowsHelloDeviceRecovery');
      await backupWindowsHelloDeviceVaultIfReady(userId);
    })().catch(() => undefined);
  }, 1_500));
}

function storageId(store: DeviceSessionStoreName, id: string): string {
  return `signal-store::${store}::${id}`;
}

function validRecord<T extends { id: string }>(value: unknown, id: string): value is T {
  return Boolean(value && typeof value === 'object' && (value as { id?: unknown }).id === id);
}

export async function readDeviceSessionRecord<T extends { id: string }>(
  store: DeviceSessionStoreName,
  id: string,
): Promise<T | null> {
  const sealed = await readDeviceVaultRecord(storageId(store, id), (value): value is T => validRecord<T>(value, id));
  if (sealed) return sealed;
  const legacy = await runTxOn('device-sessions', [store], 'readonly', (tx) =>
    reqToPromise<T | undefined>(tx.objectStore(store).get(id)),
  ).catch(() => undefined);
  if (!legacy) return null;
  return adoptLegacyPlaintextRecord({
    storageId: storageId(store, id),
    legacy,
    validate: (value): value is T => validRecord<T>(value, id),
    deleteLegacy: () => runTxOn('device-sessions', [store], 'readwrite', (tx) => {
      tx.objectStore(store).delete(id);
    }),
    stage: `device_${store}`,
  });
}

export async function writeDeviceSessionRecord<T extends { id: string }>(
  store: DeviceSessionStoreName,
  record: T,
): Promise<void> {
  await writeDeviceVaultRecord(storageId(store, record.id), record);
  await runTxOn('device-sessions', [store], 'readwrite', (tx) => {
    if (deviceVaultMirrorsPlaintext()) tx.objectStore(store).put(record);
    else tx.objectStore(store).delete(record.id);
  });
  scheduleEncryptedSessionBackup(record.id);
}

export async function removeDeviceSessionRecord(store: DeviceSessionStoreName, id: string): Promise<void> {
  // Delete the authoritative sealed copy first. Reporting success while that
  // deletion failed could resurrect an invalidated ratchet after a restart.
  await removeDeviceVaultRecord(storageId(store, id));
  await runTxOn('device-sessions', [store], 'readwrite', (tx) => tx.objectStore(store).delete(id));
}

export async function listDeviceSessionRecords<T extends { id: string }>(
  store: DeviceSessionStoreName,
  idPrefix = '',
): Promise<T[]> {
  const records = new Map<string, T>();
  const legacy = await runTxOn('device-sessions', [store], 'readonly', (tx) =>
    reqToPromise<T[]>(tx.objectStore(store).getAll()),
  ).catch(() => [] as T[]);
  for (const record of legacy) {
    if (record?.id?.startsWith(idPrefix)) records.set(record.id, record);
  }

  const prefix = storageId(store, idPrefix);
  for (const sealedId of await listDeviceVaultStorageIds(prefix)) {
    const id = sealedId.slice(`signal-store::${store}::`.length);
    const record = await readDeviceVaultRecord(sealedId, (value): value is T => validRecord<T>(value, id));
    if (record) records.set(record.id, record);
  }
  return [...records.values()];
}

export async function clearDeviceSessionRecords(store: DeviceSessionStoreName): Promise<void> {
  const records = await listDeviceSessionRecords<{ id: string }>(store);
  await Promise.all(records.map((record) => removeDeviceSessionRecord(store, record.id)));
}

export async function captureDeviceSessionSnapshot(userId: string, deviceId: string): Promise<DeviceSessionSnapshot> {
  const prefix = `${userId}::${deviceId}::`;
  const [sessions, initiating] = await Promise.all([
    listDeviceSessionRecords<{ id: string } & Record<string, unknown>>('sessions', prefix),
    listDeviceSessionRecords<{ id: string } & Record<string, unknown>>('initiating-sessions', prefix),
  ]);
  return { sessions, initiating };
}

export async function restoreDeviceSessionSnapshot(
  userId: string,
  deviceId: string,
  snapshot: DeviceSessionSnapshot,
): Promise<void> {
  const prefix = `${userId}::${deviceId}::`;
  if (!Array.isArray(snapshot?.sessions) || !Array.isArray(snapshot?.initiating)) {
    throw new Error('DEVICE_SESSION_SNAPSHOT_INVALID');
  }
  const records = [
    ...snapshot.sessions.map((record) => ({ store: 'sessions' as const, record })),
    ...snapshot.initiating.map((record) => ({ store: 'initiating-sessions' as const, record })),
  ];
  if (records.some(({ record }) => !record?.id?.startsWith(prefix))) {
    throw new Error('DEVICE_SESSION_SNAPSHOT_SCOPE_INVALID');
  }
  await Promise.all(records.map(({ store, record }) => writeDeviceSessionRecord(store, record)));
}
