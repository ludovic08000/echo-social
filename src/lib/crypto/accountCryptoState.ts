/**
 * Aegis — inspection de l'état cryptographique d'un compte.
 *
 * Invariant : une identité de compte est créée une seule fois et reste
 * permanente. Ce module ne mute rien ; il décrit uniquement la relation entre
 * l'identité publiée côté serveur, le matériel privé local et les sauvegardes
 * récupérables. Le nombre de messages n'intervient jamais dans la décision.
 */

import { supabase } from '@/integrations/supabase/client';
import { hasLocalKeys } from '@/lib/crypto/accountKeyBackup';
import { hasAegisRecoveryVault } from '@/lib/crypto/aegisRecoveryVault';
import { loadIdentityKeys, PinUnlockRequiredError } from '@/lib/crypto/keyManager';

export type AccountCryptoState =
  /** Identité locale utilisable et cohérente avec le serveur. */
  | 'READY'
  /** Aucune identité serveur, aucune sauvegarde : bootstrap normal. */
  | 'NEW_ACCOUNT'
  /** Compte ancien sans identité publiée : bootstrap normal. */
  | 'LEGACY_ACCOUNT_UNINITIALIZED'
  /** Identité serveur sans clé locale, mais une sauvegarde existe. */
  | 'RESTORABLE_IDENTITY'
  /** Identité serveur sans clé locale ni sauvegarde récupérable. */
  | 'UNRECOVERABLE_SERVER_IDENTITY'
  /** Inspection incomplète ou contradictoire : fail-closed. */
  | 'INCONSISTENT';

export interface AccountCryptoInspection {
  state: AccountCryptoState;
  userId: string;
  hasLocalIdentity: boolean;
  serverFingerprint: string | null;
  localFingerprint: string | null;
  hasAccountBackup: boolean;
  hasRecoveryBackup: boolean;
  /** Vrai si au moins une sauvegarde permet une restauration. */
  hasRestorableBackup: boolean;
  reason: string;
}

const BACKUP_TYPE_ACCOUNT = 'account';
const BACKUP_TYPE_RECOVERY = 'recovery';

function inconsistent(userId: string, reason: string): AccountCryptoInspection {
  return {
    state: 'INCONSISTENT',
    userId,
    hasLocalIdentity: false,
    serverFingerprint: null,
    localFingerprint: null,
    hasAccountBackup: false,
    hasRecoveryBackup: false,
    hasRestorableBackup: false,
    reason,
  };
}

/**
 * Inspecte l'état cryptographique du compte. Lecture seule et fail-closed :
 * toute inspection incomplète renvoie INCONSISTENT plutôt qu'une décision
 * susceptible de détruire une identité encore récupérable.
 */
export async function inspectAccountCryptoState(userId: string): Promise<AccountCryptoInspection> {
  if (!userId) return inconsistent('', 'missing_user_id');

  const [identityResult, backupsResult, devicesResult] = await Promise.all([
    supabase
      .from('user_public_keys' as never)
      .select('fingerprint')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle(),
    supabase
      .from('user_backups' as never)
      .select('backup_type')
      .eq('user_id', userId),
    supabase
      .from('user_devices' as never)
      .select('id')
      .eq('user_id', userId)
      .limit(1),
  ]);

  if (identityResult.error || backupsResult.error) {
    return inconsistent(userId, 'server_inspection_incomplete');
  }

  const serverFingerprint =
    (identityResult.data as { fingerprint?: string } | null)?.fingerprint ?? null;

  const backupTypes = new Set(
    ((backupsResult.data ?? []) as Array<{ backup_type?: unknown }>)
      .map((row) => row.backup_type)
      .filter((value): value is string => typeof value === 'string'),
  );

  let hasRecoveryVault = false;
  try {
    hasRecoveryVault = await hasAegisRecoveryVault(userId);
  } catch {
    return inconsistent(userId, 'recovery_vault_inspection_failed');
  }

  const hasAccountBackup = backupTypes.has(BACKUP_TYPE_ACCOUNT);
  const hasRecoveryBackup = backupTypes.has(BACKUP_TYPE_RECOVERY) || hasRecoveryVault;
  const hasRestorableBackup = hasAccountBackup || hasRecoveryBackup;

  let localFingerprint: string | null = null;
  let hasLocalIdentity = false;
  try {
    const keys = await loadIdentityKeys(userId);
    hasLocalIdentity = Boolean(keys);
    localFingerprint = keys?.fingerprint ?? null;
  } catch (error) {
    if (error instanceof PinUnlockRequiredError) {
      // Le matériel local existe, il est simplement verrouillé par le PIN.
      hasLocalIdentity = true;
    } else {
      return inconsistent(userId, 'local_identity_inspection_failed');
    }
  }

  if (!hasLocalIdentity) {
    try {
      hasLocalIdentity = await hasLocalKeys(userId);
    } catch {
      return inconsistent(userId, 'local_identity_inspection_failed');
    }
  }

  const base = {
    userId,
    hasLocalIdentity,
    serverFingerprint,
    localFingerprint,
    hasAccountBackup,
    hasRecoveryBackup,
    hasRestorableBackup,
  };

  if (hasLocalIdentity) {
    if (serverFingerprint && localFingerprint && serverFingerprint !== localFingerprint) {
      return { ...base, state: 'INCONSISTENT', reason: 'local_server_fingerprint_mismatch' };
    }
    return { ...base, state: 'READY', reason: 'local_identity_present' };
  }

  if (!serverFingerprint) {
    if (hasRestorableBackup) {
      // Une sauvegarde sans identité active publiée : restauration d'abord.
      return { ...base, state: 'RESTORABLE_IDENTITY', reason: 'backup_without_active_identity' };
    }
    return {
      ...base,
      state: 'NEW_ACCOUNT',
      reason: 'no_server_identity_no_backup',
    };
  }

  if (hasRestorableBackup) {
    return { ...base, state: 'RESTORABLE_IDENTITY', reason: 'server_identity_with_backup' };
  }

  return {
    ...base,
    state: 'UNRECOVERABLE_SERVER_IDENTITY',
    reason: 'server_identity_without_local_key_or_backup',
  };
}
