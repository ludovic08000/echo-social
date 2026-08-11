/**
 * Restauration automatique du coffre appareil sur iOS Web.
 *
 * Invariant : on ne restaure QUE si le DeviceID local existe déjà et que le
 * serveur reconnaît cet appareil comme approuvé et cohérent. Aucun DeviceID
 * n'est créé, deviné ou tourné silencieusement : sans coffre exploitable, le
 * lifecycle canonique reprend la main (LINK_REQUIRED / PENDING_APPROVAL).
 */

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
import { isIosRuntime } from '@/platforms/ios/capacitorBridge';

const isIosWebRuntime = isIosRuntime;


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

/** Sauvegarde opportuniste du coffre une fois le device prêt et déverrouillé. */
export async function backupIosDeviceVaultIfReady(userId: string): Promise<boolean> {
  if (!isIosWebRuntime()) return false;
  const deviceId = peekCurrentDeviceId();
  if (!userId || !deviceId || !getSessionMasterKey()) return false;
  if (!(await hasLocalDeviceKeys(userId, deviceId))) return false;
  return backupDeviceVaultToCloud({ userId, deviceId, platform: 'ios-web' });
}
