/**
 * Provider sécurisé iOS isolé.
 *
 * Invariant : ce module n'est jamais utilisé par le flux Windows. Il n'exécute
 * ni enrôlement, ni rotation, ni publication SPK/OPK. Il expose seulement du
 * stockage critique délégué et du diagnostic en lecture.
 */
import type {
  DeviceSecureProvider,
  DeviceSecureProviderDiagnostics,
} from '@/platforms/deviceSecureProvider';
import { inspectIosBridge, isNativeIosRuntime } from '@/platforms/ios/capacitorBridge';
import {
  inspectIosKeychain,
  iosKeychainGet,
  iosKeychainRemove,
  iosKeychainSet,
  iosVaultKey,
} from '@/platforms/ios/keychain';
import { inspectIosSecureEnclave } from '@/platforms/ios/secureEnclave';

function identityStorageId(userId: string, deviceId: string): string {
  return `device-signing::${userId}::${deviceId}`;
}

export const iosDeviceProvider: DeviceSecureProvider = {
  platform: 'ios',

  isSupported() {
    const bridge = inspectIosBridge();
    return bridge.isNativeIos || bridge.isIosWeb;
  },

  getSecret(key) {
    return iosKeychainGet(key);
  },

  setSecret(key, value) {
    return iosKeychainSet(key, value);
  },

  removeSecret(key) {
    return iosKeychainRemove(key);
  },

  async hasLocalIdentity(userId, deviceId) {
    if (!userId || !deviceId) return false;
    try {
      const raw = await iosKeychainGet(iosVaultKey(identityStorageId(userId, deviceId)));
      return typeof raw === 'string' && raw.length > 0;
    } catch {
      return false;
    }
  },

  async collectDiagnostics(input) {
    const bridge = inspectIosBridge();
    let lastError: string | null = null;

    const secureStorage = await inspectIosKeychain();
    if (secureStorage.warnings.length > 0) lastError = secureStorage.warnings[0];

    const enclave = await inspectIosSecureEnclave();
    if (!enclave.available && enclave.reason && !lastError) lastError = enclave.reason;

    let hasLocalIdentity = false;
    if (input?.userId && input?.deviceId) {
      try {
        hasLocalIdentity = await iosDeviceProvider.hasLocalIdentity(input.userId, input.deviceId);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    return {
      platform: 'ios',
      isNativeRuntime: isNativeIosRuntime(),
      secureStorage,
      enclave,
      hasLocalIdentity,
      lastError,
      collectedAt: new Date().toISOString(),
    } satisfies DeviceSecureProviderDiagnostics;
  },
};
