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
 * Single managed entry point for every auth-mount/resume/PIN resync request.
 * It blocks until Supabase auth is usable, preserves the physical DeviceID and
 * coalesces concurrent callers onto one publication/prekey pass.
 */
export async function resyncE2EE(
  userId: string,
  options: ResyncOptions = {},
): Promise<ResyncReport> {
  return runDeviceOperation(`resync:${userId}`, async () => {
    await requireAuthenticatedDeviceSession(userId);
    const stableDeviceId = await hydrateDeviceId().catch(() => getCurrentDeviceId());

    await recoverStableDeviceLifecycle(userId, stableDeviceId).catch((error) => {
      console.warn('[DeviceManager] lifecycle recovery deferred to registration', {
        deviceId: stableDeviceId.slice(0, 8),
        error: error instanceof Error ? error.message : String(error),
      });
    });

    const report = await legacyResyncE2EE(userId, options);
    const afterDeviceId = getCurrentDeviceId();
    if (afterDeviceId !== stableDeviceId) {
      console.error('[DeviceManager] DeviceID mutation detected during resync', {
        before: stableDeviceId.slice(0, 8),
        after: afterDeviceId.slice(0, 8),
      });
      report.ok = false;
      report.errors.push('device id changed during managed resync');
    }
    return report;
  }, { coalesce: true });
}
