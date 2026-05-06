import {
  getOrCreateIdentityKeys as strictGetOrCreateIdentityKeys,
  generateIdentityKeys,
  type IdentityKeyPair,
} from './keyManager';
import { PinUnlockRequiredError } from './keyManager';

const temporaryIdentities = new Map<string, Promise<IdentityKeyPair & { isNewIdentity?: boolean }>>();

async function getTemporaryIdentity(userId: string): Promise<IdentityKeyPair & { isNewIdentity?: boolean }> {
  const existing = temporaryIdentities.get(userId);
  if (existing) return existing;

  const created = generateIdentityKeys().then(keys => {
    console.warn('[TEST][E2EE] Temporary identity used. Restore flow is bypassed for UI testing.');
    return { ...keys, isNewIdentity: false };
  });

  temporaryIdentities.set(userId, created);
  return created;
}

export async function getOrCreateIdentityKeys(userId: string): Promise<IdentityKeyPair & { isNewIdentity?: boolean }> {
  try {
    return await strictGetOrCreateIdentityKeys(userId);
  } catch (error) {
    if (error instanceof PinUnlockRequiredError) {
      console.warn('[TEST][E2EE] PinUnlockRequiredError swallowed for UI testing.');
      return getTemporaryIdentity(userId);
    }

    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Existing E2EE identity') || message.includes('continuity')) {
      console.warn('[TEST][E2EE] Identity restore guard swallowed for UI testing.');
      return getTemporaryIdentity(userId);
    }

    throw error;
  }
}
