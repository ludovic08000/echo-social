import { restoreAegisRecoveryVault } from './aegisRecoveryVault';
import { runPostRestoreLifecycle } from './postRestoreLifecycle';

export type RecoverySource = 'pin' | 'recovery_key' | 'passkey';

export type RecoveryAttempt =
  | { source: 'pin'; pin: string }
  | { source: 'recovery_key'; key: string }
  | { source: 'passkey' };

export type RecoveryResult =
  | { ok: true; source: RecoverySource }
  | { ok: false; source: RecoverySource; reason: string };

async function finishSuccessfulRecovery(userId: string, source: RecoverySource): Promise<RecoveryResult> {
  const lifecycle = await runPostRestoreLifecycle(userId, source).catch((error) => {
    console.warn('[E2EE][recovery] post-restore lifecycle failed', error);
    return null;
  });
  if (lifecycle && !lifecycle.ok) {
    console.warn('[E2EE][recovery] post-restore lifecycle incomplete', lifecycle);
  }
  return { ok: true, source };
}

export async function hasServerBackup(userId: string): Promise<boolean> {
  try {
    const { supabase } = await import('@/integrations/supabase/client');
    const [{ data: recoveryVault }, { data: accountBackup }] = await Promise.all([
      supabase
        .from('aegis_recovery_vaults' as never)
        .select('user_id')
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('user_backups' as never)
        .select('id')
        .eq('user_id', userId)
        .eq('backup_type', 'account')
        .maybeSingle(),
    ]);
    return Boolean(recoveryVault || accountBackup);
  } catch (error) {
    console.warn('[E2EE][recovery] hasServerBackup failed', error);
    return false;
  }
}

export async function attemptRecovery(
  userId: string,
  attempt: RecoveryAttempt,
): Promise<RecoveryResult> {
  try {
    if (attempt.source === 'pin') {
      const mod = await import('./pinWrap');
      const candidate = mod as unknown as {
        restoreFromBackupPin?: (targetUserId: string, pin: string) => Promise<unknown>;
        unwrapWithPin?: (targetUserId: string, pin: string) => Promise<unknown>;
      };
      const restore = candidate.restoreFromBackupPin ?? candidate.unwrapWithPin;
      if (!restore) return { ok: false, source: 'pin', reason: 'pin_restore_unavailable' };
      const output = await restore(userId, attempt.pin);
      return output
        ? await finishSuccessfulRecovery(userId, 'pin')
        : { ok: false, source: 'pin', reason: 'pin_invalid_or_no_blob' };
    }

    if (attempt.source === 'recovery_key') {
      const restored = await restoreAegisRecoveryVault(userId, attempt.key);
      if (restored.status === 'restored' || restored.status === 'already_present') {
        return finishSuccessfulRecovery(userId, 'recovery_key');
      }
      return {
        ok: false,
        source: 'recovery_key',
        reason: 'reason' in restored && restored.reason ? restored.reason : restored.status,
      };
    }

    const mod = await import('./passkeyVault');
    const candidate = mod as unknown as {
      restoreWithPasskey?: (targetUserId: string) => Promise<unknown>;
      unwrapWithPasskey?: (targetUserId: string) => Promise<unknown>;
    };
    const restore = candidate.restoreWithPasskey ?? candidate.unwrapWithPasskey;
    if (!restore) return { ok: false, source: 'passkey', reason: 'passkey_restore_unavailable' };
    const output = await restore(userId);
    return output
      ? await finishSuccessfulRecovery(userId, 'passkey')
      : { ok: false, source: 'passkey', reason: 'passkey_cancelled_or_failed' };
  } catch (error) {
    return {
      ok: false,
      source: attempt.source,
      reason: error instanceof Error ? error.message : 'unexpected_error',
    };
  }
}
