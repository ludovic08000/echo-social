/**
 * Device Vault — couche unique de persistance des clés privées d'appareil.
 *
 * Invariant corrigé : sur navigateur, les clés privées device (Ed25519, X25519,
 * SPK/OPK) ne doivent plus exister en clair dans IndexedDB. Elles sont scellées
 * par l'enclave logicielle ACE Web (anchor AES-GCM non extractible), qui
 * échoue fermé si l'anchor disparaît.
 *
 * - Natif (iOS/Android) : délègue à nativeKeyVault (Keychain), comportement
 *   inchangé, y compris le miroir IndexedDB existant.
 * - Web (iOS Safari, Chrome, Windows) : scelle l'enregistrement via
 *   secureSetCriticalSecret -> ACE Web. Aucun miroir en clair.
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

function webKey(storageId: string): string {
  return `${WEB_KEY_PREFIX}${storageId}`;
}

/** Le miroir IndexedDB en clair n'est conservé que sur les plateformes natives. */
export function deviceVaultMirrorsPlaintext(): boolean {
  return isSecureStoreNative();
}

export function logDeviceVaultEvent(
  stage: string,
  status: 'ok' | 'skipped' | 'failed',
  extra: { reason?: string; count?: number } = {},
): void {
  logCryptoError({
    severity: status === 'failed' ? 'warning' : 'info',
    context: 'backup',
    errorCode: `DEVICE_VAULT_${stage.toUpperCase()}_${status.toUpperCase()}`,
    errorMessage: `DEVICE_VAULT_${stage.toUpperCase()}`,
    metadata: {
      stage,
      status,
      platform: isSecureStoreNative() ? 'native' : 'web',
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(typeof extra.count === 'number' ? { count: extra.count } : {}),
    },
  });
}

export async function readDeviceVaultRecord<T>(
  storageId: string,
  validate: (value: unknown) => value is T,
): Promise<T | null> {
  if (isSecureStoreNative()) return readNativeKeyRecord(storageId, validate);

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
  if (isSecureStoreNative()) {
    await writeNativeKeyRecord(storageId, payload);
    return;
  }
  const encoded = JSON.stringify({
    version: VAULT_VERSION,
    storageId,
    payload,
  } satisfies WebVaultEnvelope);
  // secureSetCriticalSecret relit systématiquement la valeur scellée (fail-closed).
  await secureSetCriticalSecret(webKey(storageId), encoded);
}

export async function removeDeviceVaultRecord(storageId: string): Promise<void> {
  if (isSecureStoreNative()) {
    await removeNativeKeyRecord(storageId);
    return;
  }
  await secureRemoveCriticalSecret(webKey(storageId));
}

/**
 * Migration sécurisée d'un ancien enregistrement en clair :
 * lire -> sceller -> vérifier la relecture -> supprimer le clair (web seulement).
 * Retourne l'enregistrement adopté, ou null si aucun héritage exploitable.
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

  await writeDeviceVaultRecord(storageId, legacy);
  const readback = await readDeviceVaultRecord(storageId, validate);
  if (!readback) {
    logDeviceVaultEvent(stage, 'failed', { reason: 'sealed_readback_missing' });
    throw new Error(`E2EE_DEVICE_VAULT_READBACK_FAILED:${storageId}`);
  }

  if (!deviceVaultMirrorsPlaintext()) {
    await deleteLegacy();
  }
  logDeviceVaultEvent(stage, 'ok', { reason: 'migrated' });
  return readback;
}
