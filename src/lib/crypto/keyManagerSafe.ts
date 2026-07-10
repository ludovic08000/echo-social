import {
  getOrCreateIdentityKeys as strictGetOrCreateIdentityKeys,
  PinUnlockRequiredError,
  type IdentityKeyPair,
} from './keyManager';
import { restoreAccountKeysFromActiveSession } from './accountKeyBackup';

type RecoveredIdentity = IdentityKeyPair & {
  isNewIdentity?: boolean;
  recoveredAfterLoss?: boolean;
};

const restoreAttempts = new Map<string, Promise<IdentityKeyPair | null>>();

async function tryRestoreLatestBackup(userId: string): Promise<IdentityKeyPair | null> {
  const existing = restoreAttempts.get(userId);
  if (existing) return existing;

  const attempt = (async () => {
    try {
      console.warn('[E2EE][RECOVERY] Local identity unavailable; attempting encrypted backup restore.');
      const restored = await restoreAccountKeysFromActiveSession(userId);

      if (restored === 'restored' || restored === 'local_ok') {
        const keys = await strictGetOrCreateIdentityKeys(userId);
        try {
          window.dispatchEvent(new CustomEvent('forsure-e2ee-identity-restored', {
            detail: { source: 'latest_backup', fingerprint: keys.fingerprint },
          }));
        } catch {}
        return keys;
      }

      return null;
    } catch (error) {
      console.warn('[E2EE][RECOVERY] Backup restore failed.', error);
      return null;
    } finally {
      restoreAttempts.delete(userId);
    }
  })();

  restoreAttempts.set(userId, attempt);
  return attempt;
}

/**
 * Recovery facade with a fail-closed continuity policy.
 *
 * It may restore the existing identity, but it never manufactures a replacement
 * identity for an account that already has continuity evidence. Identity
 * rotation requires a separate, explicit user-authorized flow that changes the
 * security code and notifies peers.
 */
export async function getOrCreateIdentityKeys(userId: string): Promise<RecoveredIdentity> {
  try {
    return await strictGetOrCreateIdentityKeys(userId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const continuityFailure = error instanceof PinUnlockRequiredError ||
      message.includes('Existing E2EE identity') ||
      message.includes('continuity') ||
      message.includes('identity continuity') ||
      message.includes('PIN unlock');

    if (!continuityFailure) throw error;

    const restored = await tryRestoreLatestBackup(userId);
    if (restored) {
      return {
        ...restored,
        isNewIdentity: false,
        recoveredAfterLoss: true,
      };
    }

    if (error instanceof PinUnlockRequiredError) throw error;
    throw new PinUnlockRequiredError(
      `PIN_UNLOCK_REQUIRED: existing identity continuity could not be restored (${message}).`,
    );
  }
}
