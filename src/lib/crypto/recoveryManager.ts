/**
 * RecoveryManager — single entry point for restoring the local E2EE identity
 * from one of the three supported backup channels:
 *
 *   1. PIN backup (L5, WhatsApp-style 6 digits)
 *   2. Recovery key (64-hex, single-use)
 *   3. Passkey / WebAuthn vault
 *
 * The actual crypto primitives live in their dedicated modules; this layer
 * only routes the call, normalises the result, and lets the
 * `CryptoStateMachine` decide what to do next.
 */

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
  const lifecycle = await runPostRestoreLifecycle(userId, source).catch((err) => {
    console.warn('[E2EE][recovery] post-restore lifecycle failed', err);
    return null;
  });

  if (lifecycle && !lifecycle.ok) {
    console.warn('[E2EE][recovery] post-restore lifecycle incomplete', lifecycle);
  }

  return { ok: true, source };
}

/**
 * Probe whether a server-side backup exists for this user.
 * Used by the state machine to decide between `backup_restore_required`
 * and `identity_creating`.
 */
export async function hasServerBackup(userId: string): Promise<boolean> {
  try {
    const { supabase } = await import('@/integrations/supabase/client');
    const { data } = await supabase
      .from('user_backups' as any)
      .select('id')
      .eq('user_id', userId)
      .eq('backup_type', 'account')
      .maybeSingle();
    return !!data;
  } catch (e) {
    console.warn('[E2EE][recovery] hasServerBackup failed', e);
    return false;
  }
}

/** Run a recovery attempt. Never throws — always returns a tagged result. */
export async function attemptRecovery(
  userId: string,
  attempt: RecoveryAttempt,
): Promise<RecoveryResult> {
  try {
    if (attempt.source === 'pin') {
      const mod = await import('./pinWrap');
      const fn = (mod as any).restoreFromBackupPin ?? (mod as any).unwrapWithPin;
      if (typeof fn !== 'function') {
        return { ok: false, source: 'pin', reason: 'pin_restore_unavailable' };
      }
      const out = await fn(userId, attempt.pin);
      return out
        ? await finishSuccessfulRecovery(userId, 'pin')
        : { ok: false, source: 'pin', reason: 'pin_invalid_or_no_blob' };
    }

    if (attempt.source === 'recovery_key') {
      const mod = await import('./recoveryKey');
      const fn = (mod as any).restoreWithRecoveryKey ?? (mod as any).unwrapWithRecoveryKey;
      if (typeof fn !== 'function') {
        return { ok: false, source: 'recovery_key', reason: 'recovery_key_restore_unavailable' };
      }
      const out = await fn(userId, attempt.key);
      return out
        ? await finishSuccessfulRecovery(userId, 'recovery_key')
        : { ok: false, source: 'recovery_key', reason: 'recovery_key_invalid' };
    }

    if (attempt.source === 'passkey') {
      const mod = await import('./passkeyVault');
      const fn = (mod as any).restoreWithPasskey ?? (mod as any).unwrapWithPasskey;
      if (typeof fn !== 'function') {
        return { ok: false, source: 'passkey', reason: 'passkey_restore_unavailable' };
      }
      const out = await fn(userId);
      return out
        ? await finishSuccessfulRecovery(userId, 'passkey')
        : { ok: false, source: 'passkey', reason: 'passkey_cancelled_or_failed' };
    }

    return {
      ok: false,
      source: (attempt as RecoveryAttempt).source,
      reason: 'unknown_source',
    };
  } catch (e) {
    return {
      ok: false,
      source: attempt.source,
      reason: (e as Error).message ?? 'unexpected_error',
    };
  }
}
