import { repairCurrentDevicePrekeys as legacyRepair } from '../crypto/devicePrekeyRepair';
import { runDeviceOperation } from './operationLock';
import { requireAuthenticatedDeviceSession } from './sessionGate';
import { recoverStableDeviceLifecycle } from './lifecycle';

/**
 * One SPK repair at a time per device. The previous flow allowed auth mount,
 * resume and PIN unlock to purge/generate SPKs concurrently (#2, #3, #4 in the
 * same second), then one caller immediately declared the new bundle invalid.
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
    if (lifecycle.state !== 'approved' && lifecycle.state !== 'missing') {
      return { repaired: false, reason: `device-${lifecycle.state}` };
    }
    return legacyRepair(userId, deviceId, signingPrivateKey, reason);
  }, { coalesce: true });
}
