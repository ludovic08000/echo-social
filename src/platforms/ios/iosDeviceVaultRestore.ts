/**
 * Restauration automatique du coffre appareil sur iOS Web.
 *
 * Invariant : on ne restaure QUE si le DeviceID local existe déjà et que le
 * serveur reconnaît cet appareil comme approuvé et cohérent. Aucun DeviceID
 * n'est créé, deviné ou tourné silencieusement : sans coffre exploitable, le
 * lifecycle canonique reprend la main (LINK_REQUIRED / PENDING_APPROVAL).
 */

import { supabase } from '@/integrations/supabase/client';
import { peekCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { fetchVerifiedDeviceIdentity } from '@/lib/crypto/canonicalDeviceRegistry';
import { loadDeviceIdentity } from '@/lib/crypto/deviceIdentity';
import { loadDeviceKxKey } from '@/lib/crypto/deviceKx';
import { getSessionMasterKey } from '@/lib/crypto/accountKeyBackup';
import {
  backupDeviceVaultToCloud,
  restoreDeviceVaultFromCloud,
} from '@/lib/crypto/deviceVaultSync';
import { logDeviceVaultEvent } from '@/lib/crypto/deviceVault';
import { isIosWebRuntime } from '@/platforms/ios/iosRuntime';

const BACKUP_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;
const backupRetryAttempts = new Map<string, number>();
const backupRetryTimers = new Map<string, number>();
const backupInFlight = new Map<string, Promise<boolean>>();

export type IosVaultRestoreOutcome =
  | 'restored'
  | 'not_needed'
  | 'skipped_not_ios'
  | 'skipped_no_device'
  | 'skipped_unknown_device'
  | 'skipped_no_master_key'
  | 'failed';

async function hasLocalDeviceKeys(userId: string, deviceId: string): Promise<boolean> {
  try {
    const [signing, kx] = await Promise.all([
      loadDeviceIdentity(userId, deviceId),
      loadDeviceKxKey(deviceId, userId),
    ]);
    return Boolean(signing && kx);
  } catch {
    return false;
  }
}

async function isServerDeviceBound(userId: string, deviceId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('user_devices')
    .select('approval_status,binding_status,lifecycle_status,routing_status,is_active,revoked_at')
    .eq('user_id', userId)
    .eq('device_id', deviceId)
    .maybeSingle();
  if (error || !data) return false;
  const row = data as {
    approval_status?: string | null;
    binding_status?: string | null;
    lifecycle_status?: string | null;
    routing_status?: string | null;
    is_active?: boolean | null;
    revoked_at?: string | null;
  };
  return row.approval_status === 'approved'
    && row.binding_status === 'bound'
    && row.is_active === true
    && row.revoked_at == null;
}

function clearBackupRetry(cacheKey: string): void {
  backupRetryAttempts.delete(cacheKey);
  const timer = backupRetryTimers.get(cacheKey);
  if (timer !== undefined && typeof window !== 'undefined') window.clearTimeout(timer);
  backupRetryTimers.delete(cacheKey);
}

function scheduleBackupRetry(userId: string, deviceId: string, reason: string): void {
  if (!isIosWebRuntime() || typeof window === 'undefined') return;
  const cacheKey = `${userId}:${deviceId}`;
  if (backupRetryTimers.has(cacheKey)) return;
  const attempt = backupRetryAttempts.get(cacheKey) ?? 0;
  if (attempt >= BACKUP_RETRY_DELAYS_MS.length) {
    logDeviceVaultEvent('ios_backup', 'failed', { reason: `retry_exhausted:${reason}` });
    return;
  }
  backupRetryAttempts.set(cacheKey, attempt + 1);
  const timer = window.setTimeout(() => {
    backupRetryTimers.delete(cacheKey);
    void backupIosDeviceVaultIfReady(userId);
  }, BACKUP_RETRY_DELAYS_MS[attempt]);
  backupRetryTimers.set(cacheKey, timer);
  logDeviceVaultEvent('ios_backup', 'skipped', { reason: `retry_scheduled:${reason}` });
}

export async function ensureIosDeviceVaultRestored(userId: string): Promise<IosVaultRestoreOutcome> {
  if (!isIosWebRuntime()) return 'skipped_not_ios';
  if (!userId) return 'skipped_no_device';

  const deviceId = peekCurrentDeviceId();
  if (!deviceId) {
    logDeviceVaultEvent('ios_restore', 'skipped', { reason: 'no_local_device_id' });
    return 'skipped_no_device';
  }

  if (await hasLocalDeviceKeys(userId, deviceId)) return 'not_needed';

  const identity = await fetchVerifiedDeviceIdentity(userId, deviceId);
  if (!identity || !identity.devicePublicKey || !identity.deviceSigningKey) {
    logDeviceVaultEvent('ios_restore', 'skipped', { reason: 'device_unknown_or_unapproved' });
    return 'skipped_unknown_device';
  }

  if (!getSessionMasterKey()) {
    logDeviceVaultEvent('ios_restore', 'skipped', { reason: 'master_key_locked' });
    return 'skipped_no_master_key';
  }

  const restored = await restoreDeviceVaultFromCloud({
    userId,
    deviceId,
    expectedDeviceSigningKey: identity.deviceSigningKey,
    expectedDevicePublicKey: identity.devicePublicKey,
  });
  if (!restored) return 'failed';

  logDeviceVaultEvent('ios_restore', 'ok');
  window.dispatchEvent(new CustomEvent('forsure:device-vault-restored', {
    detail: { deviceId },
  }));
  return 'restored';
}

/**
 * Sauvegarde opportuniste du coffre iOS Web uniquement une fois le device
 * serveur réellement READY. Si le lifecycle ou la Master Key arrivent quelques
 * secondes plus tard, un retry borné reprend le même DeviceID sans rotation.
 */
export async function backupIosDeviceVaultIfReady(userId: string): Promise<boolean> {
  if (!isIosWebRuntime()) return false;
  const deviceId = peekCurrentDeviceId();
  if (!userId || !deviceId) return false;
  const cacheKey = `${userId}:${deviceId}`;
  const existing = backupInFlight.get(cacheKey);
  if (existing) return existing;

  const run = (async (): Promise<boolean> => {
    if (!(await isServerDeviceBound(userId, deviceId))) {
      scheduleBackupRetry(userId, deviceId, 'device_not_bound');
      return false;
    }
    if (!getSessionMasterKey()) {
      scheduleBackupRetry(userId, deviceId, 'master_key_locked');
      return false;
    }
    if (!(await hasLocalDeviceKeys(userId, deviceId))) {
      logDeviceVaultEvent('ios_backup', 'failed', { reason: 'local_device_keys_missing' });
      return false;
    }

    const backedUp = await backupDeviceVaultToCloud({ userId, deviceId, platform: 'ios-web' });
    if (!backedUp) {
      scheduleBackupRetry(userId, deviceId, 'cloud_backup_failed');
      return false;
    }
    clearBackupRetry(cacheKey);
    logDeviceVaultEvent('ios_backup', 'ok');
    return true;
  })().finally(() => {
    backupInFlight.delete(cacheKey);
  });

  backupInFlight.set(cacheKey, run);
  return run;
}

export const __test__ = {
  resetBackupRetries(): void {
    for (const cacheKey of backupRetryTimers.keys()) clearBackupRetry(cacheKey);
    backupRetryAttempts.clear();
    backupInFlight.clear();
  },
};
