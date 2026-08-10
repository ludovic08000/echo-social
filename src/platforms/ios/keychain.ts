/**
 * Abstraction Keychain iOS.
 *
 * Elle délègue au routeur secureStore existant (AegisKeychain natif,
 * ACE Web côté navigateur) : aucune duplication de cryptographie, aucun
 * changement du chemin Windows.
 */
import {
  isSecureStoreNative,
  secureGetCriticalSecret,
  secureRemoveCriticalSecret,
  secureSetCriticalSecret,
  verifySecureStoreHealth,
} from '@/lib/secureStore';
import type { SecureStorageStatus } from '@/platforms/deviceSecureProvider';

const PROBE_KEY = 'ios.platform.probe';
const NATIVE_VAULT_PREFIX = 'aegis.native-key-vault.v1:';

export function iosKeychainGet(key: string): Promise<string | null> {
  return secureGetCriticalSecret(key);
}

export function iosKeychainSet(key: string, value: string): Promise<void> {
  return secureSetCriticalSecret(key, value);
}

export function iosKeychainRemove(key: string): Promise<void> {
  return secureRemoveCriticalSecret(key);
}

/** Clé du coffre natif utilisée par nativeKeyVault pour un enregistrement. */
export function iosVaultKey(storageId: string): string {
  return `${NATIVE_VAULT_PREFIX}${storageId}`;
}

/** Diagnostic non destructif : lit la santé du coffre, sans écrire de secret. */
export async function inspectIosKeychain(): Promise<SecureStorageStatus> {
  try {
    const health = await verifySecureStoreHealth();
    return {
      available: health.pluginAvailable || health.tier === 'web-enclave',
      roundTripOk: health.probeRoundTripOk,
      tier: health.tier,
      warnings: health.warnings,
    };
  } catch (error) {
    return {
      available: false,
      roundTripOk: false,
      tier: isSecureStoreNative() ? 'keychain' : 'web',
      warnings: [error instanceof Error ? error.message : String(error)],
    };
  }
}

/** Aller-retour explicite, réservé aux écrans de diagnostic. */
export async function probeIosKeychainRoundTrip(): Promise<boolean> {
  const value = `probe-${Date.now()}`;
  try {
    await iosKeychainSet(PROBE_KEY, value);
    const readback = await iosKeychainGet(PROBE_KEY);
    await iosKeychainRemove(PROBE_KEY);
    return readback === value;
  } catch {
    return false;
  }
}
