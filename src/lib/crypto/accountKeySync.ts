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

  return withEnsureLock(userId, async (): Promise<AccountKeySyncOutcome> => {
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
      return 'local_keys_present';
    }

    const keychainStatus = await restoreKeysFromKeychainSnapshot(userId);
    if (keychainStatus === 'restored') {
      announce('forsure-keys-restored', { status: 'restored_from_keychain_snapshot' });
      return 'restored_from_keychain_snapshot';
    }

    if (wrappedKeysPresent) {
      // Le matériel local existe mais reste scellé : seul le PIN peut l'ouvrir.
      requireRestore(userId, 'pin_unlock_required');
    }

    const restoreStatus = await restoreAccountKeysFromActiveSession(userId);
    if (restoreStatus === 'restored' || restoreStatus === 'local_ok') {
      announce('forsure-keys-restored', { status: 'restored_active_session' });
      return 'restored_active_session';
    }

    // Démarrage à froid : une sentinelle sécurisée + une sauvegarde de compte
    // prouvent qu'une identité existe déjà. On exige sa restauration explicite.
    try {
      const { readKeySentinel } = await import('@/lib/crypto/keySentinel');
      const sentinel = await readKeySentinel();
      if (sentinel && sentinel.userId === userId) {
        const { data: backupRow } = await supabase
          .from('user_backups')
          .select('id, backup_type, created_at')
          .eq('user_id', userId)
          .eq('backup_type', 'account')
          .maybeSingle();
        if (backupRow) {
          requireRestore(userId, 'cold_start_sentinel', {
            lastSyncAt: sentinel.lastSyncAt,
            native: isNativePlatform(),
          });
        }
        console.warn('[messaging] stale key sentinel: no account backup row');
      } else if (sentinel && sentinel.userId !== userId) {
        console.warn('[messaging] key sentinel belongs to another account — ignored');
      }
    } catch (error) {
      if (error instanceof AccountKeyRestoreRequiredError) throw error;
      console.warn('[messaging] sentinel cold-start check failed:', error);
    }

    if (await hasLocalKeys(userId)) return 'local_keys_present';

    try {
      const snap = getSnapshot(userId);
      if (snap.state === 'storage_checking') {
        transition(userId, 'backup_restore_required', 'accountKeySync.fallback');
      }
    } catch {
      // State-machine fallback is best-effort.
    }

    // Aucun matériel restaurable : compte neuf, l'identité sera créée par le
    // runtime crypto canonique (jamais ici) — on n'invente aucun état prêt.
    return 'no_backup_new_account';
  });
}
