import {
  getOrCreateIdentityKeys as strictGetOrCreateIdentityKeys,
  PinUnlockRequiredError,
  type IdentityKeyPair,
} from './keyManager';
import { restoreAccountKeysFromActiveSession } from './accountKeyBackup';

type RecoveredIdentity = IdentityKeyPair & { isNewIdentity?: boolean; recoveredAfterLoss?: boolean };

const restoreAttempts = new Map<string, Promise<IdentityKeyPair | null>>();

function normalizeIdentity(keys: IdentityKeyPair, recoveredAfterLoss = false): RecoveredIdentity {
  return {
    ...keys,
    isNewIdentity: false,
    recoveredAfterLoss,
  };
}

async function tryRestoreLatestBackup(userId: string): Promise<IdentityKeyPair | null> {
  const existing = restoreAttempts.get(userId);
  if (existing) return existing;

  const attempt = (async () => {
    try {
      console.warn('[E2EE][RECOVERY] Local identity missing; attempting encrypted backup restore.');
      const restored = await restoreAccountKeysFromActiveSession(userId);

      if (restored === 'restored' || restored === 'local_ok') {
        const keys = await strictGetOrCreateIdentityKeys(userId);
        try {
          window.dispatchEvent(new CustomEvent('forsure-e2ee-identity-restored', {
            detail: { source: 'active_session_backup', fingerprint: keys.fingerprint },
          }));
        } catch {
          // Event delivery is optional outside browser runtimes.
        }
        return keys;
      }

      return null;
    } catch (error) {
      if (!(error instanceof PinUnlockRequiredError)) {
        console.warn('[E2EE][RECOVERY] Backup restore failed.', error);
      }
      return null;
    }
  })().finally(() => {
    restoreAttempts.delete(userId);
  });

  restoreAttempts.set(userId, attempt);
  return attempt;
}

function announceRestoreRequired(userId: string, reason: string): void {
  try {
    window.dispatchEvent(new CustomEvent('forsure:e2ee-restore-needed', {
      detail: {
        userId,
        reason: 'identity_continuity_guard',
        source: 'keyManagerSafe',
        diagnostic: reason,
      },
    }));
    window.dispatchEvent(new CustomEvent('forsure:e2ee-pin-unlock-required', {
      detail: { userId, source: 'keyManagerSafe' },
    }));
  } catch {
    // Event delivery is optional outside browser runtimes.
  }
}

/**
 * Resolve the account identity without ever rotating it implicitly.
 *
 * The strict key manager creates an identity only when it has proved that the
 * account is genuinely new: no local wrap, no active server identity and no
 * server backup. When continuity already exists, this wrapper may attempt an
 * authenticated restore, but it must propagate the restore requirement if
 * that attempt is unavailable. Creating a replacement identity here would
 * overwrite the account root and invalidate every existing device and peer.
 */
export async function getOrCreateIdentityKeys(userId: string): Promise<RecoveredIdentity> {
  try {
    const keys = await strictGetOrCreateIdentityKeys(userId);
    const metadata = keys as IdentityKeyPair & {
      isNewIdentity?: boolean;
      recoveredAfterLoss?: boolean;
    };
    return {
      ...keys,
      isNewIdentity: metadata.isNewIdentity === true,
      recoveredAfterLoss: metadata.recoveredAfterLoss === true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const continuityFailure =
      error instanceof PinUnlockRequiredError ||
      message.includes('Existing E2EE identity') ||
      message.includes('continuity') ||
      message.includes('identity continuity') ||
      message.toLowerCase().includes('pin unlock');

    if (!continuityFailure) throw error;

    const restored = await tryRestoreLatestBackup(userId);
    if (restored) return normalizeIdentity(restored, true);

    announceRestoreRequired(userId, message);
    if (error instanceof PinUnlockRequiredError) throw error;
    throw new PinUnlockRequiredError(
      message || 'PIN_UNLOCK_REQUIRED: restore the existing account identity before continuing.',
    );
  }
}
