/**
 * Post-Restore Sync — final step after any successful E2EE key restore.
 *
 * Run AFTER the local identity has been re-hydrated (recovery key, PIN backup,
 * password active-session, in-memory Master Key). Three responsibilities:
 *
 *   1. **Publish a fresh `keys_epoch`** for the current device. Contacts
 *      observing `device_signed_prekeys` via realtime will see the bump and
 *      invalidate any cached prekey bundle / Double Ratchet session targeting
 *      this device, forcing a fresh X3DH on the next outbound message.
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

import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import { logCryptoError, logCryptoException } from './errorLogger';

export type RestoreReason =
  | 'recovery_key'
  | 'pin_backup'
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

  // 1. Bump server-side epoch — contacts will see this via realtime.
  if (deviceId && !isDeviceIdTemporary()) {
    try {
      const { data, error } = await (supabase as any).rpc('bump_device_keys_epoch', {
        p_user_id: userId,
        p_device_id: deviceId,
      });
      if (error) {
        logCryptoError({
          severity: 'warning',
          context: 'restore',
          errorCode: 'POST_RESTORE_EPOCH_BUMP_FAILED',
          errorMessage: error.message,
          myDeviceId: deviceId,
          metadata: { reason },
        });
      } else {
        logCryptoError({
          severity: 'info',
          context: 'restore',
          errorCode: 'POST_RESTORE_EPOCH_BUMPED',
          errorMessage: 'Device keys_epoch bumped after restore',
          myDeviceId: deviceId,
          metadata: { reason, newEpoch: data },
        });
      }
    } catch (e) {
      logCryptoException('restore', e, {
        severity: 'warning',
        myDeviceId: deviceId ?? undefined,
        metadata: { stage: 'bump_device_keys_epoch', reason },
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
