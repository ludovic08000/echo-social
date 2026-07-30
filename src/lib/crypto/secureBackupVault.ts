import { loadIdentityKeys, type IdentityKeyPair } from './keyManager';
import {
  createOrRotateAegisRecoveryVault,
  hasAegisRecoveryVault,
  restoreAegisRecoveryVault,
} from './aegisRecoveryVault';

export interface CreatedSecureBackupVault {
  recoveryKey: string;
  fingerprint: string;
}

/**
 * Compatibility facade for callers that still use the old module name.
 * All cryptographic work is performed by the single Aegis recovery-vault path.
 */
export async function createSecureBackupVault(userId: string): Promise<CreatedSecureBackupVault | null> {
  const created = await createOrRotateAegisRecoveryVault(userId);
  return {
    recoveryKey: created.recoveryKey,
    fingerprint: created.fingerprint,
  };
}

export async function restoreSecureBackupVault(
  userId: string,
  recoveryKey: string,
): Promise<IdentityKeyPair | null> {
  const result = await restoreAegisRecoveryVault(userId, recoveryKey);
  if (result.status !== 'restored' && result.status !== 'already_present') return null;
  return loadIdentityKeys(userId);
}

export async function hasSecureBackupVault(userId: string): Promise<boolean> {
  return hasAegisRecoveryVault(userId);
}
