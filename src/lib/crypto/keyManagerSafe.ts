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

function normalizeIdentity(keys: IdentityKeyPair, recoveredAfterLoss = false): RecoveredIdentity {
  // Critical compatibility rule:
  // useE2EE.ts still contains a legacy guard that blocks when isNewIdentity=true
  // and an older server key/backup exists. Identity recovery is now handled by
  // identityRecovery/identityBootstrap, so this public safe facade must never
  // expose isNewIdentity=true to runtime hooks.
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
      console.warn('[E2EE][RECOVERY] Local identity missing; attempting latest encrypted backup restore.');
      const restored = await restoreAccountKeysFromActiveSession(userId);

      if (restored === 'restored' || restored === 'local_ok') {
        const keys = await strictGetOrCreateIdentityKeys(userId);

        try {
          window.dispatchEvent(new CustomEvent('forsure-e2ee-identity-restored', {
            detail: { source: 'latest_backup', fingerprint: keys.fingerprint },
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
    const restored = await tryRestoreLatestBackup(userId);
    if (restored) return normalizeIdentity(restored, true);

    console.warn('[E2EE][RECOVERY] No usable backup found; creating a replacement identity epoch.', { reason });

    const keys = await generateIdentityKeys();
    await saveIdentityKeys(userId, keys);

    try {
      window.dispatchEvent(new CustomEvent('forsure-e2ee-identity-recreated', {
        detail: { reason, fingerprint: keys.fingerprint },
      }));
      window.dispatchEvent(new CustomEvent('forsure-e2ee-security-code-changed', {
        detail: { reason, fingerprint: keys.fingerprint },
      }));
    } catch {}

    return normalizeIdentity(keys, true);
  })();

  recoveryIdentities.set(userId, created);
  return created;
}

export async function getOrCreateIdentityKeys(userId: string): Promise<RecoveredIdentity> {
  try {
    const keys = await strictGetOrCreateIdentityKeys(userId);
    return normalizeIdentity(keys, !!(keys as any).recoveredAfterLoss);
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
