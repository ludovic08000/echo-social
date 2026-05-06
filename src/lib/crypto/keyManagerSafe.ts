import {
  getOrCreateIdentityKeys as strictGetOrCreateIdentityKeys,
  generateIdentityKeys,
  saveIdentityKeys,
  type IdentityKeyPair,
} from './keyManager';
import { PinUnlockRequiredError } from './keyManager';
import { restoreAccountKeysFromActiveSession } from './accountKeyBackup';

type RecoveredIdentity = IdentityKeyPair & { isNewIdentity?: boolean; recoveredAfterLoss?: boolean };

const recoveryIdentities = new Map<string, Promise<RecoveredIdentity>>();
const restoreAttempts = new Map<string, Promise<IdentityKeyPair | null>>();

async function tryRestoreLatestBackup(userId: string): Promise<IdentityKeyPair | null> {
  const existing = restoreAttempts.get(userId);
  if (existing) return existing;

  const attempt = (async () => {
    try {
      console.warn('[E2EE][RECOVERY] Local identity missing; attempting latest encrypted backup restore.');

      const restored = await restoreAccountKeysFromActiveSession(userId);

      if (restored === 'restored' || restored === 'local_ok') {
        const keys = await strictGetOrCreateIdentityKeys(userId);

        try {
          window.dispatchEvent(new CustomEvent('forsure-e2ee-identity-restored', {
            detail: {
              source: 'latest_backup',
              fingerprint: keys.fingerprint,
            },
          }));
        } catch {}

        console.info('[E2EE][RECOVERY] Identity restored from latest encrypted backup.');
        return keys;
      }

      return null;
    } catch (error) {
      console.warn('[E2EE][RECOVERY] Backup restore failed.', error);
      return null;
    }
  })();

  restoreAttempts.set(userId, attempt);
  return attempt;
}

async function createReplacementIdentity(userId: string, reason: string): Promise<RecoveredIdentity> {
  const existing = recoveryIdentities.get(userId);
  if (existing) return existing;

  const created = (async () => {
    // STEP 1: try restoring the most recent encrypted backup.
    const restored = await tryRestoreLatestBackup(userId);

    if (restored) {
      return {
        ...restored,
        isNewIdentity: false,
        recoveredAfterLoss: true,
      };
    }

    // STEP 2: fallback to a new persistent identity.
    console.warn('[E2EE][RECOVERY] No usable backup found; creating a replacement identity.', { reason });

    const keys = await generateIdentityKeys();
    await saveIdentityKeys(userId, keys);

    try {
      window.dispatchEvent(new CustomEvent('forsure-e2ee-identity-recreated', {
        detail: {
          reason,
          fingerprint: keys.fingerprint,
        },
      }));
    } catch {}

    return {
      ...keys,
      isNewIdentity: false,
      recoveredAfterLoss: true,
    };
  })();

  recoveryIdentities.set(userId, created);
  return created;
}

export async function getOrCreateIdentityKeys(userId: string): Promise<RecoveredIdentity> {
  try {
    return await strictGetOrCreateIdentityKeys(userId);
  } catch (error) {
    if (error instanceof PinUnlockRequiredError) {
      return createReplacementIdentity(userId, error.message || 'pin_required');
    }

    const message = error instanceof Error ? error.message : String(error);

    if (
      message.includes('Existing E2EE identity') ||
      message.includes('continuity') ||
      message.includes('identity continuity') ||
      message.includes('PIN unlock')
    ) {
      return createReplacementIdentity(userId, message);
    }

    throw error;
  }
}
