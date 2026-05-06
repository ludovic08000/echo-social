import {
  loadIdentityKeys,
  generateIdentityKeys,
  saveIdentityKeys,
  type IdentityKeyPair,
} from './keyManager';
import { getOrCreateIdentityKeys } from './keyManagerSafe';
import { restoreAccountKeysFromActiveSession } from './accountKeyBackup';

export type IdentityRecoveryMode = 'local' | 'restored' | 'new_epoch';

export async function resolveUserIdentity(userId: string): Promise<{ keys: IdentityKeyPair; mode: IdentityRecoveryMode }> {
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
        } catch {}
        return { keys: restoredKeys, mode: 'restored' };
      }
    }
  } catch (error) {
    console.warn('[E2EE][RECOVERY] encrypted backup restore unavailable', error);
  }

  try {
    const keys = await getOrCreateIdentityKeys(userId);
    return { keys, mode: (keys as any).recoveredAfterLoss ? 'new_epoch' : 'local' };
  } catch (error) {
    console.warn('[E2EE][RECOVERY] safe identity resolution failed; creating new epoch', error);
  }

  const keys = await generateIdentityKeys();
  await saveIdentityKeys(userId, keys);

  try {
    window.dispatchEvent(new CustomEvent('forsure-e2ee-security-code-changed', {
      detail: { userId, fingerprint: keys.fingerprint, reason: 'new_epoch_after_recovery_failure' },
    }));
  } catch {}

  return { keys, mode: 'new_epoch' };
}
