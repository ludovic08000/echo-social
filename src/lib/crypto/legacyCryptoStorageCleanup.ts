import { openE2EEDB } from './indexedDb';
import { listDeviceVaultStorageIds, removeDeviceVaultRecord } from './deviceVault';

export const LEGACY_CRYPTO_DATABASES = [
  'forsure-ratchet',
  'forsure-device-sessions',
  'forsure-spk',
  'forsure-prekeys',
  'forsure-x3dh-replay',
  'forsure-crypto-skipped-wrap',
] as const;

export const LEGACY_DEVICE_VAULT_PREFIXES = [
  'signal-store::',
  'x3dh-prekey::',
] as const;

export const LEGACY_CRYPTO_CLEANUP_MARKER =
  'forsure:legacy-crypto-storage-cleanup:libsignal-only';

export interface LegacyCryptoCleanupResult {
  complete: boolean;
  removedDatabases: number;
  removedVaultRecords: number;
}

function deleteIndexedDatabase(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => finish(true);
    request.onerror = () => finish(false);
    request.onblocked = () => finish(false);
  });
}

function cleanupAlreadyCompleted(): boolean {
  try {
    return localStorage.getItem(LEGACY_CRYPTO_CLEANUP_MARKER) === '1';
  } catch {
    return false;
  }
}

function markCleanupCompleted(): void {
  try {
    localStorage.setItem(LEGACY_CRYPTO_CLEANUP_MARKER, '1');
  } catch {
    // Le nettoyage reste valide même si le marqueur local est indisponible.
  }
}

/**
 * Purge irréversible et bornée des stores des moteurs antérieurs. L'upgrade
 * `forsure-e2ee` conserve l'identité Aegis et le store Libsignal scellé.
 */
export async function cleanupLegacyCryptoStorage(): Promise<LegacyCryptoCleanupResult> {
  if (cleanupAlreadyCompleted()) {
    return { complete: true, removedDatabases: 0, removedVaultRecords: 0 };
  }
  if (typeof indexedDB === 'undefined') {
    return { complete: false, removedDatabases: 0, removedVaultRecords: 0 };
  }

  try {
    await openE2EEDB();
  } catch {
    return { complete: false, removedDatabases: 0, removedVaultRecords: 0 };
  }

  const databaseResults = await Promise.all(
    LEGACY_CRYPTO_DATABASES.map((name) => deleteIndexedDatabase(name)),
  );
  let removedVaultRecords = 0;
  let vaultComplete = true;

  for (const prefix of LEGACY_DEVICE_VAULT_PREFIXES) {
    try {
      const storageIds = await listDeviceVaultStorageIds(prefix);
      for (const storageId of storageIds) {
        await removeDeviceVaultRecord(storageId);
        removedVaultRecords += 1;
      }
    } catch {
      vaultComplete = false;
    }
  }

  const complete = databaseResults.every(Boolean) && vaultComplete;
  if (complete) markCleanupCompleted();
  return {
    complete,
    removedDatabases: databaseResults.filter(Boolean).length,
    removedVaultRecords,
  };
}
