/**
 * Synchronisation impérative des clés de compte avant runtime.
 *
 * Invariant cryptographique : la messagerie ne s'ouvre qu'après une VRAIE
 * vérification/restauration des clés de compte (clés locales, matériel brut,
 * coffre protégé par PIN, snapshot keychain, session active, sentinelle +
 * sauvegarde serveur). Aucun état « ready » n'est simulé : si une restauration
 * explicite par l'utilisateur est indispensable, on lève
 * `AccountKeyRestoreRequiredError` et le flux reste bloqué avec retry.
 */
import { supabase } from '@/integrations/supabase/client';
import {
  hasLocalKeys,
  restoreAccountKeysFromActiveSession,
  restoreKeysFromKeychainSnapshot,
  syncKeychainSnapshotFromLocal,
} from '@/lib/crypto/accountKeyBackup';
import { isNativePlatform } from '@/lib/nativeStore';
import { transition, withEnsureLock, getSnapshot } from '@/lib/crypto/CryptoStateMachine';
import {
  startFinalizationTimer,
  traceCurrentDeviceFinalization,
} from '@/lib/device-manager/deviceFinalizationTrace';

export type AccountKeySyncOutcome =
  | 'local_keys_present'
  | 'restored_from_keychain_snapshot'
  | 'restored_active_session'
  | 'no_backup_new_account';

export class AccountKeyRestoreRequiredError extends Error {
  readonly restoreReason: string;

  constructor(restoreReason: string) {
    super(`ACCOUNT_KEY_RESTORE_REQUIRED:${restoreReason}`);
    this.name = 'AccountKeyRestoreRequiredError';
    this.restoreReason = restoreReason;
  }
}

function announce(event: string, detail: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(event, { detail }));
  } catch {
    // Event delivery is best effort.
  }
}

function requireRestore(userId: string, reason: string, extra: Record<string, unknown> = {}): never {
  traceCurrentDeviceFinalization({
    step: 'account_key_sync.restore_required',
    outcome: 'failure',
    userId,
    detail: reason,
    errorCode: 'ACCOUNT_KEY_RESTORE_REQUIRED',
  });
  announce('forsure:e2ee-restore-needed', {
    userId,
    reason,
    source: 'accountKeySync',
    ...extra,
  });
  throw new AccountKeyRestoreRequiredError(reason);
}

/**
 * Exécute réellement le contrôle/restauration des clés de compte.
 * Appelée une seule fois par la barrière `beginAccountSynchronization`.
 */
export async function synchronizeAccountKeysBeforeRuntime(userId: string): Promise<AccountKeySyncOutcome> {
  if (!userId) throw new Error('ACCOUNT_SYNC_USER_REQUIRED');

  let outcome: AccountKeySyncOutcome = 'no_backup_new_account';
  const run = async (): Promise<void> => {
    try {
      transition(userId, 'storage_checking', 'accountKeySync.beforeRuntime');
    } catch {
      // A concurrent bootstrap may already own this transition.
    }

    const [{ hasWrappedKeys }, { hasRawIdentityKeys }] = await Promise.all([
      import('@/lib/crypto/pinWrap'),
      import('@/lib/crypto/keyManager'),
    ]);

    const [localKeysPresent, rawIdentityPresent, wrappedKeysPresent] = await Promise.all([
      hasLocalKeys(userId),
      hasRawIdentityKeys(userId),
      hasWrappedKeys(userId),
    ]);

    console.log('[messaging] account key sync check', {
      userId,
      localKeysPresent,
      rawIdentityPresent,
      wrappedKeysPresent,
      native: isNativePlatform(),
    });

    if (rawIdentityPresent) {
      await syncKeychainSnapshotFromLocal(userId);
      const refreshed = await restoreKeysFromKeychainSnapshot(userId);
      if (refreshed === 'restored') {
        announce('forsure-keys-restored', { status: 'refreshed_from_keychain_snapshot' });
      }
      outcome = 'local_keys_present';
      return;
    }

    const keychainStatus = await restoreKeysFromKeychainSnapshot(userId);
    if (keychainStatus === 'restored') {
      announce('forsure-keys-restored', { status: 'restored_from_keychain_snapshot' });
      outcome = 'restored_from_keychain_snapshot';
      return;
    }

    if (wrappedKeysPresent) {
      // Le matériel local existe mais reste scellé : seul le PIN peut l'ouvrir.
      requireRestore(userId, 'pin_unlock_required');
    }

    const restoreStatus = await restoreAccountKeysFromActiveSession(userId);
    if (restoreStatus === 'restored' || restoreStatus === 'local_ok') {
      announce('forsure-keys-restored', { status: 'restored_active_session' });
      outcome = 'restored_active_session';
      return;
    }

    if (await hasLocalKeys(userId)) {
      outcome = 'local_keys_present';
      return;
    }

    // Invariant corrigé : la preuve d'existence d'une identité sauvegardée est
    // SERVEUR, jamais la sentinelle locale (purgeable). Sans cette lecture, un
    // stockage purgé conduirait à créer une seconde identité (fork).
    let sentinelPresent = false;
    try {
      const { readKeySentinel } = await import('@/lib/crypto/keySentinel');
      const sentinel = await readKeySentinel();
      sentinelPresent = Boolean(sentinel && sentinel.userId === userId);
    } catch (error) {
      console.warn('[messaging] key sentinel read failed:', error);
    }

    const backupProbe = await supabase
      .from('user_backups')
      .select('id')
      .eq('user_id', userId)
      .eq('backup_type', 'account')
      .limit(1);

    if (backupProbe.error) {
      // Fail-closed : impossible de prouver l'absence de sauvegarde.
      try {
        const snap = getSnapshot(userId);
        if (snap.state === 'storage_checking') {
          transition(userId, 'backup_restore_required', 'accountKeySync.probeFailed');
        }
      } catch {
        // State-machine fallback is best-effort.
      }
      requireRestore(userId, 'account_backup_probe_failed', {
        sentinelPresent,
        native: isNativePlatform(),
      });
    }

    if ((backupProbe.data ?? []).length > 0) {
      requireRestore(userId, sentinelPresent ? 'cold_start_sentinel' : 'server_backup_without_sentinel', {
        sentinelPresent,
        native: isNativePlatform(),
      });
    }

    try {
      const snap = getSnapshot(userId);
      if (snap.state === 'storage_checking') {
        transition(userId, 'backup_restore_required', 'accountKeySync.fallback');
      }
    } catch {
      // State-machine fallback is best-effort.
    }

    // Preuve serveur qu'aucune sauvegarde n'existe et aucune clé locale : compte
    // neuf, l'identité sera créée par le runtime crypto canonique (jamais ici).
    outcome = 'no_backup_new_account';
  };

  await withEnsureLock(userId, run);
  return outcome;
}
