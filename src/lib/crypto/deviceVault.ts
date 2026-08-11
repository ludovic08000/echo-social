/**
 * Device Vault — persistance protégée des clés privées device.
 *
 * IMPORTANT : le chemin WebCrypto ACE est STRICTEMENT limité à iOS Web/PWA.
 * Windows Web conserve exactement son stockage historique IndexedDB et ne
 * passe jamais par ACE via ce module. Les plateformes natives conservent leur
 * nativeKeyVault/Keychain existant.
 */

import {
  isSecureStoreNative,
  secureGetCriticalSecret,
  secureRemoveCriticalSecret,
  secureSetCriticalSecret,
} from '@/lib/secureStore';
import { isIosWebRuntime } from '@/platforms/ios/iosRuntime';
import {
  readNativeKeyRecord,
  removeNativeKeyRecord,
  writeNativeKeyRecord,
} from './nativeKeyVault';
import { logCryptoError } from './errorLogger';

const VAULT_VERSION = 1 as const;
const IOS_WEB_KEY_PREFIX = 'aegis.device-vault.v1:';

type DeviceVaultMode = 'native' | 'ios-web' | 'legacy-web';

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
  if (isIosWebRuntime()) return 'ios-web';
  return 'legacy-web';
}

function webKey(storageId: string): string {
  return `${IOS_WEB_KEY_PREFIX}${storageId}`;
}

/**
 * Le miroir IndexedDB historique reste l'autorité sur Windows Web et reste
 * conservé sur natif. Seul iOS Web interdit le miroir privé en clair.
 */
export function deviceVaultMirrorsPlaintext(): boolean {
  return mode() !== 'ios-web';
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

  // Windows/desktop Web : comportement historique inchangé. Le caller relit
  // son IndexedDB legacy comme avant ce chantier.
  if (vaultMode === 'legacy-web') return null;

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
  if (vaultMode === 'legacy-web') return;

  const encoded = JSON.stringify({
    version: VAULT_VERSION,
    storageId,
    payload,
  } satisfies WebVaultEnvelope);

  await secureSetCriticalSecret(webKey(storageId), encoded);

  // Invariant fail-closed : readback explicite sur iOS Web en plus du readback
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

  if (vaultMode === 'legacy-web') return;
  await secureRemoveCriticalSecret(webKey(storageId));
}

/**
 * Migration d'un ancien record privé en clair.
 *
 * - iOS Web : legacy -> ACE -> readback -> suppression du legacy.
 * - natif : comportement historique nativeKeyVault + miroir conservé.
 * - Windows/desktop Web : retourne simplement le legacy, sans migration ni
 *   suppression. C'est volontaire afin de ne modifier aucun comportement
 *   Windows dans ce lot.
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
  if (vaultMode === 'legacy-web') {
    return legacy;
  }

  await writeDeviceVaultRecord(storageId, legacy);
  const readback = await readDeviceVaultRecord(storageId, validate);
  if (!readback) {
    logDeviceVaultEvent(stage, 'failed', { reason: 'sealed_readback_missing' });
    throw new Error(`E2EE_DEVICE_VAULT_READBACK_FAILED:${storageId}`);
  }

  if (vaultMode === 'ios-web') {
    await deleteLegacy();
  }

  logDeviceVaultEvent(stage, 'ok', { reason: 'migrated' });
  return readback;
}
