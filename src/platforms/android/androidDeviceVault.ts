import { fetchVerifiedDeviceIdentity } from '@/lib/crypto/canonicalDeviceRegistry';
import { getSessionMasterKey } from '@/lib/crypto/accountKeyBackup';
import { backupDeviceVaultToCloud, restoreDeviceVaultFromCloud } from '@/lib/crypto/deviceVaultSync';
import { loadDeviceIdentity } from '@/lib/crypto/deviceIdentity';
import { loadDeviceKxKey } from '@/lib/crypto/deviceKx';
import { peekCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { isAndroidRuntime } from './androidRuntime';

export async function restoreAndroidDeviceVault(userId: string): Promise<boolean> {
  if (!isAndroidRuntime() || !getSessionMasterKey()) return false;
  const deviceId = peekCurrentDeviceId();
  if (!deviceId) return false;
  const [identity, kx] = await Promise.all([loadDeviceIdentity(userId, deviceId), loadDeviceKxKey(deviceId, userId)]);
  if (identity && kx) return true;
  const expected = await fetchVerifiedDeviceIdentity(userId, deviceId);
  if (!expected?.deviceSigningKey || !expected.devicePublicKey) return false;
  return restoreDeviceVaultFromCloud({
    userId,
    deviceId,
    expectedDeviceSigningKey: expected.deviceSigningKey,
    expectedDevicePublicKey: expected.devicePublicKey,
  });
}

export async function backupAndroidDeviceVault(userId: string): Promise<boolean> {
  if (!isAndroidRuntime() || !getSessionMasterKey()) return false;
  const deviceId = peekCurrentDeviceId();
  return deviceId ? backupDeviceVaultToCloud({ userId, deviceId, platform: 'android' }) : false;
}
