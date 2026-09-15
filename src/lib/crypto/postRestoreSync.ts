/**
 * Post-Restore Sync — final step after any successful E2EE key restore.
 *
 * Run AFTER the local identity has been re-hydrated (recovery key, PIN backup,
 * password active-session, in-memory Master Key). Three responsibilities:
 *
 *   1. **Revalidate the sealed Libsignal store and public bundle pool** for the
 *      current device. No custom Signed PreKey epoch participates in routing.
 *
 *   2. **Trigger a queue resume** so messages that piled up during the wipe
 *      (and that couldn't be decrypted before keys were back) get retried
 *      immediately — Signal-style invisible recovery.
 *
 *   3. **Emit a `forsure:e2ee-post-restore` event** so UI (TOFU banner,
 *      sender-key rotation watcher, etc.) can react with a recovery-aware
 *      copy instead of a generic "identity changed" warning.
 *
 * Idempotent — safe to call from every restore site.
 */

import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { logCryptoError, logCryptoException } from './errorLogger';

export type RestoreReason =
  | 'recovery_key'
  | 'pin_backup'
  | 'password_sign_in'
  | 'password_active_session'
  | 'in_memory_master_key'
  | 'manual';

let lastRunAt = 0;
const MIN_INTERVAL_MS = 5_000;

export async function runPostRestoreSync(userId: string, reason: RestoreReason): Promise<void> {
  if (!userId) return;
  const now = Date.now();
  if (now - lastRunAt < MIN_INTERVAL_MS) return;
  lastRunAt = now;

  const deviceId = (() => {
    try { return getCurrentDeviceId(); } catch { return null; }
  })();

  // 1. Le store scellé et le pool public Libsignal sont l'unique source session.
  if (deviceId && !isDeviceIdTemporary()) {
    try {
      const { provisionLibsignalDevice } = await import('./libsignalProvisioning');
      await provisionLibsignalDevice(userId, deviceId);
      logCryptoError({
        severity: 'info',
        context: 'restore',
        errorCode: 'POST_RESTORE_LIBSIGNAL_READY',
        errorMessage: 'Libsignal store and bundle pool revalidated after restore',
        myDeviceId: deviceId,
        metadata: { reason },
      });
    } catch (e) {
      logCryptoException('restore', e, {
        severity: 'warning',
        myDeviceId: deviceId ?? undefined,
        metadata: { stage: 'provision_libsignal_device', reason },
      });
    }
  }

  // 2. Publish a recovery marker so peers classify the upcoming fingerprint
  //    rotation as a benign restore (TOFU recovery-aware) instead of MITM.
  try {
    const [{ loadIdentityKeys }, { publishRecoveryMarker }] = await Promise.all([
      import('./keyManager'),
      import('./recoveryMarkers'),
    ]);
    const keys = await loadIdentityKeys(userId).catch(() => null);
    if (keys?.fingerprint) {
      await publishRecoveryMarker({ userId, fingerprint: keys.fingerprint, reason });
    }
  } catch (e) {
    logCryptoException('restore', e, {
      severity: 'warning',
      myDeviceId: deviceId ?? undefined,
      metadata: { stage: 'publish_recovery_marker', reason },
    });
  }

  // 3. Emit event for UI + sender-key watchers.
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('forsure:e2ee-post-restore', {
        detail: { userId, reason, at: now },
      }));
    }
  } catch {
    // non-fatal
  }

}
