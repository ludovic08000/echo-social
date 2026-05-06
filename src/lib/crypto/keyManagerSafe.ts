import {
  getOrCreateIdentityKeys as strictGetOrCreateIdentityKeys,
  generateIdentityKeys,
  saveIdentityKeys,
  type IdentityKeyPair,
} from './keyManager';
import { PinUnlockRequiredError } from './keyManager';

type RecoveredIdentity = IdentityKeyPair & { isNewIdentity?: boolean; recoveredAfterLoss?: boolean };

const recoveryIdentities = new Map<string, Promise<RecoveredIdentity>>();

async function createReplacementIdentity(userId: string, reason: string): Promise<RecoveredIdentity> {
  const existing = recoveryIdentities.get(userId);
  if (existing) return existing;

  const created = (async () => {
    console.warn('[E2EE][RECOVERY] Identity recovery unavailable; creating a replacement local identity for future messages.', { reason });

    const keys = await generateIdentityKeys();
    await saveIdentityKeys(userId, keys);

    try {
      window.dispatchEvent(new CustomEvent('forsure-e2ee-identity-recreated', {
        detail: { reason, fingerprint: keys.fingerprint },
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
