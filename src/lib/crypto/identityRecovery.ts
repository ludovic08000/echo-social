import {
  loadIdentityKeys,
  generateIdentityKeys,
  saveIdentityKeys,
  getOrCreateIdentityKeys,
  type IdentityKeyPair,
} from './keyManager';
import { restoreAccountKeysFromActiveSession } from './accountKeyBackup';

export async function resolveUserIdentity(userId: string): Promise<{ keys: IdentityKeyPair; mode: 'local' | 'restored' | 'new_epoch' }> {
  const local = await loadIdentityKeys(userId).catch(() => null);
  if (local) return { keys: local, mode: 'local' };

  try {
    const restored = await restoreAccountKeysFromActiveSession(userId);
    if (restored === 'restored' || restored === 'local_ok') {
      const restoredKeys = await loadIdentityKeys(userId).catch(() => null);
      if (restoredKeys) return { keys: restoredKeys, mode: 'restored' };
    }
  } catch (error) {
    console.warn('[E2EE][RECOVERY] restore unavailable', error);
  }

  try {
    const keys = await getOrCreateIdentityKeys(userId);
    return { keys, mode: (keys as any).recoveredAfterLoss ? 'new_epoch' : 'local' };
  } catch (error) {
    console.warn('[E2EE][RECOVERY] strict identity resolution failed; creating new epoch', error);
  }

  const keys = await generateIdentityKeys();
  await saveIdentityKeys(userId, keys);
  return { keys, mode: 'new_epoch' };
}
