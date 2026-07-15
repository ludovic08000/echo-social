import { repairCurrentDevicePrekeys as legacyRepair } from '../crypto/devicePrekeyRepair';
import { runDeviceOperation } from './operationLock';
import { requireAuthenticatedDeviceSession } from './sessionGate';
import { recoverStableDeviceLifecycle } from './lifecycle';

/**
 * One SPK repair at a time. If the supplied DeviceID was revoked, lifecycle
 * recovery returns its fresh replacement and all new SPK/OPK material is bound
 * to that replacement only.
 */
export async function repairCurrentDevicePrekeys(
  userId: string,
  deviceId: string,
  signingPrivateKey: CryptoKey,
  reason: string,
): Promise<{ repaired: boolean; reason: string }> {
  const key = `prekey-repair:${userId}:${deviceId}`;
  return runDeviceOperation(key, async () => {
    await requireAuthenticatedDeviceSession(userId);
    const lifecycle = await recoverStableDeviceLifecycle(userId, deviceId);
    if (lifecycle.state !== 'approved') {
      return { repaired: false, reason: `device-${lifecycle.state}` };
    }
    return legacyRepair(userId, lifecycle.deviceId, signingPrivateKey, reason);
  }, { coalesce: true });
}
