import { supabase } from '@/integrations/supabase/client';
import type { DeviceApiRecord } from '@/lib/api/deviceApi';
import { loadDeviceIdentity } from '@/lib/crypto/deviceIdentity';
import { loadDeviceKxKey } from '@/lib/crypto/deviceKx';
import { repairCurrentDevicePrekeys } from '@/lib/crypto/devicePrekeyRepair';
import { runTxOn, reqToPromise } from '@/lib/crypto/indexedDbTx';
import { invalidateAegisDeviceRuntime } from '@/lib/messaging/aegisDeviceRuntime';
import { invalidateAllFanoutRoutes } from '@/lib/messaging/fanoutRouteCache';
import { clearDeviceCopyCache } from '@/lib/messaging/multiDeviceFanout';
import { isIosWebRuntime } from '@/platforms/ios/iosRuntime';

const PREKEY_STORE = 'signed-prekeys';
const SESSION_STORE = 'sessions';
const INITIATING_STORE = 'initiating-sessions';

interface StoredPrekeyRecord {
  id: string;
  spkId: number;
  privateKeyJWK: JsonWebKey;
  publicKeyBase64: string;
  createdAt: number;
}

type ServerSpk = {
  spk_id: number;
  public_key: string;
};

type ServerOpk = {
  opk_id: number;
  public_key: string;
};

export type IosMessagingIntegrityIssue =
  | 'none'
  | 'not-ready'
  | 'local-device-keys-missing'
  | 'local-device-key-mismatch'
  | 'local-prekeys-missing'
  | 'integrity-check-failed';

export interface IosMessagingIntegrityReport {
  issue: IosMessagingIntegrityIssue;
  deviceId: string | null;
  signingKeyMatches: boolean;
  kxKeyMatches: boolean;
  spkMatches: boolean;
  opksMatch: boolean;
  serverOpkCount: number;
  localOpkCount: number;
  repairablePrekeys: boolean;
}

function isReadyRecord(record: DeviceApiRecord): boolean {
  return Boolean(
    record.approvalStatus === 'approved'
      && record.bindingStatus === 'bound'
      && record.routingStatus === 'ready'
      && record.lifecycleStatus === 'ready'
      && record.isActive
      && !record.revokedAt,
  );
}

function spkStorageKey(userId: string, deviceId: string, spkId: number): string {
  return `${userId}::dev::${deviceId}::${spkId}`;
}

function opkStorageKey(userId: string, deviceId: string, opkId: number): string {
  return `${userId}::dev::${deviceId}::opk::${opkId}`;
}

async function loadLocalPrekeyRecords(): Promise<StoredPrekeyRecord[]> {
  return runTxOn('spk', [PREKEY_STORE], 'readonly', (tx) =>
    reqToPromise<StoredPrekeyRecord[]>(tx.objectStore(PREKEY_STORE).getAll()),
  ).catch(() => [] as StoredPrekeyRecord[]);
}

async function loadServerPrekeys(userId: string, deviceId: string): Promise<{
  spk: ServerSpk | null;
  opks: ServerOpk[];
}> {
  const [spkResult, opkResult] = await Promise.all([
    supabase
      .from('device_signed_prekeys')
      .select('spk_id,public_key')
      .eq('user_id', userId)
      .eq('device_id', deviceId)
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('device_one_time_prekeys')
      .select('opk_id,public_key')
      .eq('user_id', userId)
      .eq('device_id', deviceId),
  ]);

  if (spkResult.error) throw new Error(`IOS_SPK_LOOKUP_FAILED:${spkResult.error.message}`);
  if (opkResult.error) throw new Error(`IOS_OPK_LOOKUP_FAILED:${opkResult.error.message}`);

  return {
    spk: (spkResult.data as ServerSpk | null) ?? null,
    opks: (opkResult.data ?? []) as ServerOpk[],
  };
}

export async function inspectIosMessagingIntegrity(
  userId: string,
  record: DeviceApiRecord | null,
): Promise<IosMessagingIntegrityReport> {
  if (!isIosWebRuntime()) {
    return {
      issue: 'none',
      deviceId: record?.deviceId ?? null,
      signingKeyMatches: true,
      kxKeyMatches: true,
      spkMatches: true,
      opksMatch: true,
      serverOpkCount: 0,
      localOpkCount: 0,
      repairablePrekeys: false,
    };
  }

  if (!record || !isReadyRecord(record)) {
    return {
      issue: 'not-ready',
      deviceId: record?.deviceId ?? null,
      signingKeyMatches: false,
      kxKeyMatches: false,
      spkMatches: false,
      opksMatch: false,
      serverOpkCount: 0,
      localOpkCount: 0,
      repairablePrekeys: false,
    };
  }

  try {
    const [identity, kx] = await Promise.all([
      loadDeviceIdentity(userId, record.deviceId),
      loadDeviceKxKey(record.deviceId, userId),
    ]);

    if (!identity || !kx) {
      return {
        issue: 'local-device-keys-missing',
        deviceId: record.deviceId,
        signingKeyMatches: false,
        kxKeyMatches: false,
        spkMatches: false,
        opksMatch: false,
        serverOpkCount: 0,
        localOpkCount: 0,
        repairablePrekeys: false,
      };
    }

    const signingKeyMatches = identity.publicB64 === record.deviceSigningKey;
    const kxKeyMatches = kx.publicB64 === record.devicePublicKey;
    if (!signingKeyMatches || !kxKeyMatches) {
      return {
        issue: 'local-device-key-mismatch',
        deviceId: record.deviceId,
        signingKeyMatches,
        kxKeyMatches,
        spkMatches: false,
        opksMatch: false,
        serverOpkCount: 0,
        localOpkCount: 0,
        repairablePrekeys: false,
      };
    }

    const [{ spk, opks }, localRecords] = await Promise.all([
      loadServerPrekeys(userId, record.deviceId),
      loadLocalPrekeyRecords(),
    ]);
    const localById = new Map(localRecords.map((entry) => [entry.id, entry]));

    const localSpk = spk ? localById.get(spkStorageKey(userId, record.deviceId, spk.spk_id)) : null;
    const spkMatches = Boolean(
      spk
        && localSpk
        && localSpk.publicKeyBase64 === spk.public_key
        && localSpk.privateKeyJWK,
    );

    const localOpkPrefix = `${userId}::dev::${record.deviceId}::opk::`;
    const localOpkCount = localRecords.filter((entry) => entry.id.startsWith(localOpkPrefix)).length;
    const opksMatch = opks.every((opk) => {
      const local = localById.get(opkStorageKey(userId, record.deviceId, opk.opk_id));
      return Boolean(local && local.publicKeyBase64 === opk.public_key && local.privateKeyJWK);
    });

    if (!spkMatches || !opksMatch) {
      return {
        issue: 'local-prekeys-missing',
        deviceId: record.deviceId,
        signingKeyMatches,
        kxKeyMatches,
        spkMatches,
        opksMatch,
        serverOpkCount: opks.length,
        localOpkCount,
        repairablePrekeys: true,
      };
    }

    return {
      issue: 'none',
      deviceId: record.deviceId,
      signingKeyMatches,
      kxKeyMatches,
      spkMatches,
      opksMatch,
      serverOpkCount: opks.length,
      localOpkCount,
      repairablePrekeys: false,
    };
  } catch {
    return {
      issue: 'integrity-check-failed',
      deviceId: record.deviceId,
      signingKeyMatches: false,
      kxKeyMatches: false,
      spkMatches: false,
      opksMatch: false,
      serverOpkCount: 0,
      localOpkCount: 0,
      repairablePrekeys: false,
    };
  }
}

async function purgeLocalDeviceSessions(userId: string, deviceId: string): Promise<void> {
  const prefix = `${userId}::${deviceId}::`;
  await runTxOn('device-sessions', [SESSION_STORE, INITIATING_STORE], 'readwrite', (tx) =>
    new Promise<void>((resolve, reject) => {
      const stores = [tx.objectStore(SESSION_STORE), tx.objectStore(INITIATING_STORE)];
      let remaining = stores.length;
      let failed = false;
      const done = () => {
        remaining -= 1;
        if (!failed && remaining === 0) resolve();
      };
      for (const store of stores) {
        const request = store.openCursor();
        request.onerror = () => {
          if (failed) return;
          failed = true;
          reject(request.error);
        };
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            done();
            return;
          }
          if (String(cursor.key).startsWith(prefix)) cursor.delete();
          cursor.continue();
        };
      }
    }),
  ).catch(() => undefined);
}

export async function repairIosMessagingPrekeys(
  userId: string,
  record: DeviceApiRecord,
): Promise<void> {
  if (!isIosWebRuntime()) throw new Error('IOS_REPAIR_ONLY');
  if (!isReadyRecord(record)) throw new Error('IOS_DEVICE_NOT_READY');

  const [identity, kx] = await Promise.all([
    loadDeviceIdentity(userId, record.deviceId),
    loadDeviceKxKey(record.deviceId, userId),
  ]);
  if (!identity || !kx) throw new Error('IOS_DEVICE_PRIVATE_KEYS_MISSING');
  if (identity.publicB64 !== record.deviceSigningKey || kx.publicB64 !== record.devicePublicKey) {
    throw new Error('IOS_DEVICE_LOCAL_SERVER_KEY_MISMATCH');
  }

  await repairCurrentDevicePrekeys(
    userId,
    record.deviceId,
    identity.privateKey,
    'ios-local-prekey-integrity-mismatch',
  );
  await purgeLocalDeviceSessions(userId, record.deviceId);

  invalidateAllFanoutRoutes();
  invalidateAegisDeviceRuntime(userId);
  clearDeviceCopyCache();
  try {
    window.dispatchEvent(new CustomEvent('forsure:aegis-route-ready', {
      detail: { deviceId: record.deviceId, reason: 'ios-prekeys-repaired' },
    }));
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
  } catch {
    // Browser event delivery is best-effort.
  }
}
