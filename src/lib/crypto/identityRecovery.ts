import {
  loadIdentityKeys,
  PinUnlockRequiredError,
  type IdentityKeyPair,
} from './keyManager';
import { getOrCreateIdentityKeys } from './keyManagerSafe';
import { restoreAccountKeysFromActiveSession } from './accountKeyBackup';

export type IdentityRecoveryMode = 'local' | 'restored' | 'new_epoch';

function announceRestoreRequired(userId: string, reason: string): void {
  try {
    window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
      detail: {
        userId,
        reason: 'identity_recovery_required',
        source: 'identityRecovery',
        diagnostic: reason,
      },
    }));
  } catch {
    // Event delivery is optional outside browser runtimes.
  }
}

/**
 * Resolve the stable account identity.
 *
 * A new epoch is returned only when the strict key manager has proved that the
 * account has no prior identity or backup. Recovery failures never generate a
 * replacement identity: they stay blocked until the existing identity is
 * restored with the PIN, password session, recovery key or passkey.
 */
export async function resolveUserIdentity(userId: string): Promise<{
  keys: IdentityKeyPair;
  mode: IdentityRecoveryMode;
}> {
  const local = await loadIdentityKeys(userId).catch(() => null);
  if (local) return { keys: local, mode: 'local' };

  try {
    const restored = await restoreAccountKeysFromActiveSession(userId);
    if (restored === 'restored' || restored === 'local_ok') {
      const restoredKeys = await loadIdentityKeys(userId).catch(() => null);
      if (restoredKeys) {
        try {
          window.dispatchEvent(new CustomEvent('forsure-e2ee-identity-restored', {
            detail: { userId, fingerprint: restoredKeys.fingerprint },
          }));
        } catch {
          // Event delivery is optional outside browser runtimes.
        }
        return { keys: restoredKeys, mode: 'restored' };
      }
    }
  } catch (error) {
    if (!(error instanceof PinUnlockRequiredError)) {
      console.warn('[E2EE][RECOVERY] encrypted backup restore unavailable', error);
    }
  }

  try {
    const keys = await getOrCreateIdentityKeys(userId);
    return {
      keys,
      mode: keys.isNewIdentity === true
        ? 'new_epoch'
        : keys.recoveredAfterLoss === true
          ? 'restored'
          : 'local',
    };
  } catch (error) {
    if (error instanceof PinUnlockRequiredError) {
      announceRestoreRequired(userId, error.message);
    }
    throw error;
  }
}
