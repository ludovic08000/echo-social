/**
 * Device Vault — persistance protégée des clés privées device.
 *
 * Tous les navigateurs utilisent ACE Web. Les plateformes natives utilisent
 * leur Keychain/Keystore ; leur ancien miroir IndexedDB reste conservé tant
 * qu'une purge locale séparée n'a pas été explicitement autorisée.
 */

import {
  isSecureStoreNative,
  secureGetCriticalSecret,
  secureRemoveCriticalSecret,
  secureSetCriticalSecret,
} from '@/lib/secureStore';
import {
  readNativeKeyRecord,
  removeNativeKeyRecord,
  writeNativeKeyRecord,
} from './nativeKeyVault';
import { logCryptoError } from './errorLogger';

const VAULT_VERSION = 1 as const;
const WEB_KEY_PREFIX = 'aegis.device-vault.v1:';
const WEB_MANIFEST_KEY = 'aegis.device-vault.v1:manifest';

type DeviceVaultMode = 'native' | 'web';

interface WebVaultEnvelope {
  version: typeof VAULT_VERSION;
  storageId: string;
  payload: unknown;
}

export class DeviceVaultCorruptError extends Error {
  constructor(storageId: string) {
    super(`E2EE_DEVICE_VAULT_CORRUPT:${storageId}`);
    this.name = 'DeviceVaultCorruptError';
  }
}

function mode(): DeviceVaultMode {
  if (isSecureStoreNative()) return 'native';
  return 'web';
}

function webKey(storageId: string): string {
  return `${WEB_KEY_PREFIX}${storageId}`;
}

async function readWebManifest(): Promise<string[]> {
  const encoded = await secureGetCriticalSecret(WEB_MANIFEST_KEY);
  if (!encoded) return [];
  try {
    const parsed = JSON.parse(encoded);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

async function updateWebManifest(storageId: string, present: boolean): Promise<void> {
  const current = new Set(await readWebManifest());
  if (present) current.add(storageId);
  else current.delete(storageId);
  await secureSetCriticalSecret(WEB_MANIFEST_KEY, JSON.stringify([...current].sort()));
}

export async function listDeviceVaultStorageIds(prefix: string): Promise<string[]> {
  if (mode() !== 'web') return [];
  return (await readWebManifest()).filter((storageId) => storageId.startsWith(prefix));
}

/**
 * Le miroir IndexedDB historique reste l'autorité sur Windows Web et reste
 * conservé sur natif. Seul iOS Web interdit le miroir privé en clair.
 */
export function deviceVaultMirrorsPlaintext(): boolean {
  return mode() === 'native';
}

export function logDeviceVaultEvent(
  stage: string,
  status: 'ok' | 'skipped' | 'failed',
  extra: { reason?: string; count?: number } = {},
): void {
  const vaultMode = mode();
  logCryptoError({
    severity: status === 'failed' ? 'warning' : 'info',
    context: 'backup',
    errorCode: `DEVICE_VAULT_${stage.toUpperCase()}_${status.toUpperCase()}`,
    errorMessage: `DEVICE_VAULT_${stage.toUpperCase()}`,
    metadata: {
      stage,
      status,
      platform: vaultMode,
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(typeof extra.count === 'number' ? { count: extra.count } : {}),
    },
  });
}

export async function readDeviceVaultRecord<T>(
  storageId: string,
  validate: (value: unknown) => value is T,
): Promise<T | null> {
  const vaultMode = mode();

  if (vaultMode === 'native') {
    return readNativeKeyRecord(storageId, validate);
  }

  const encoded = await secureGetCriticalSecret(webKey(storageId));
  if (encoded === null) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    throw new DeviceVaultCorruptError(storageId);
  }

  const envelope = decoded as Partial<WebVaultEnvelope> | null;
  if (
    !envelope ||
    envelope.version !== VAULT_VERSION ||
    envelope.storageId !== storageId ||
    !validate(envelope.payload)
  ) {
    throw new DeviceVaultCorruptError(storageId);
  }

  return envelope.payload;
}

export async function writeDeviceVaultRecord<T>(storageId: string, payload: T): Promise<void> {
  const vaultMode = mode();

  if (vaultMode === 'native') {
    await writeNativeKeyRecord(storageId, payload);
    return;
  }

  // Windows/desktop Web : no-op volontaire. Le caller écrit ensuite dans son
  // IndexedDB historique, donc zéro modification du flux Windows validé.

  const encoded = JSON.stringify({
    version: VAULT_VERSION,
    storageId,
    payload,
  } satisfies WebVaultEnvelope);

  await secureSetCriticalSecret(webKey(storageId), encoded);
  await updateWebManifest(storageId, true);

  // Invariant fail-closed : readback explicite sur le Web en plus du readback
  // interne de secureSetCriticalSecret/webAegisEnclaveSet.
  const readback = await secureGetCriticalSecret(webKey(storageId));
  if (readback !== encoded) {
    throw new Error(`E2EE_IOS_WEB_DEVICE_VAULT_READBACK_FAILED:${storageId}`);
  }
}

export async function removeDeviceVaultRecord(storageId: string): Promise<void> {
  const vaultMode = mode();

  if (vaultMode === 'native') {
    await removeNativeKeyRecord(storageId);
    return;
  }

  await secureRemoveCriticalSecret(webKey(storageId));
  await updateWebManifest(storageId, false);
}

/**
 * Migration d'un ancien record privé en clair.
 *
 * - Web : ancien record -> ACE -> readback -> suppression du duplicata.
 * - Natif : Keychain/Keystore + conservation temporaire du miroir existant.
 */
export async function adoptLegacyPlaintextRecord<T>(args: {
  storageId: string;
  legacy: unknown;
  validate: (value: unknown) => value is T;
  deleteLegacy: () => Promise<void>;
  stage: string;
}): Promise<T | null> {
  const { storageId, legacy, validate, deleteLegacy, stage } = args;
  if (legacy === null || legacy === undefined) return null;

  if (!validate(legacy)) {
    logDeviceVaultEvent(stage, 'failed', { reason: 'legacy_invalid' });
    throw new DeviceVaultCorruptError(storageId);
  }

  const vaultMode = mode();
  await writeDeviceVaultRecord(storageId, legacy);
  const readback = await readDeviceVaultRecord(storageId, validate);
  if (!readback) {
    logDeviceVaultEvent(stage, 'failed', { reason: 'sealed_readback_missing' });
    throw new Error(`E2EE_DEVICE_VAULT_READBACK_FAILED:${storageId}`);
  }

  if (vaultMode === 'web') {
    await deleteLegacy();
  }

  logDeviceVaultEvent(stage, 'ok', { reason: 'migrated' });
  return readback;
}
