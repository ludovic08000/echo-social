import {
  resyncE2EE as legacyResyncE2EE,
  type ResyncOptions,
  type ResyncReport,
  type ResyncStep,
  type DiagEntry,
  type DiagLevel,
  type MessageReplayDetail,
} from '../crypto/resyncE2EE';
import { getCurrentDeviceId, hydrateDeviceId } from './currentDevice';
import { runDeviceOperation } from './operationLock';
import { requireAuthenticatedDeviceSession } from './sessionGate';
import { recoverStableDeviceLifecycle } from './lifecycle';

export type {
  ResyncOptions,
  ResyncReport,
  ResyncStep,
  DiagEntry,
  DiagLevel,
  MessageReplayDetail,
};

/**
 * Managed resync for one active DeviceID. A revoked ID may be replaced exactly
 * once by recoverStableDeviceLifecycle(); the remainder of this pass must then
 * use the returned replacement ID, not the retired one.
 */
export async function resyncE2EE(
  userId: string,
  options: ResyncOptions = {},
): Promise<ResyncReport> {
  return runDeviceOperation(`resync:${userId}`, async () => {
    await requireAuthenticatedDeviceSession(userId);
    const initialDeviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());
    const lifecycle = await recoverStableDeviceLifecycle(userId, initialDeviceId);
    const activeDeviceId = lifecycle.deviceId;

    if (activeDeviceId !== initialDeviceId) {
      console.info('[DeviceManager] resync continuing with reenrolled DeviceID', {
        previous: initialDeviceId.slice(0, 8),
        current: activeDeviceId.slice(0, 8),
      });
    }

    const report = await legacyResyncE2EE(userId, options);
    const afterDeviceId = getCurrentDeviceId();
    if (afterDeviceId !== activeDeviceId) {
      console.error('[DeviceManager] unexpected DeviceID mutation during resync', {
        expected: activeDeviceId.slice(0, 8),
        after: afterDeviceId.slice(0, 8),
      });
      report.ok = false;
      report.errors.push('device id changed unexpectedly during managed resync');
    }
    return report;
  }, { coalesce: true });
}
