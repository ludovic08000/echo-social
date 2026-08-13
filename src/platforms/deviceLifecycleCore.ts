/**
 * DeviceLifecycleCore : sélection du provider plateforme d'attestation locale.
 *
 * Invariants :
 * - le lifecycle canonique (AUTHENTICATED -> DEVICE_CREDENTIAL_CHECK ->
 *   LINK_REQUIRED/PENDING_APPROVAL -> APPROVED_LOCKED -> PIN_UNLOCK ->
 *   ACCOUNT_KEY_SYNC -> MESSAGING_READY) reste inchangé ;
 * - un provider n'ajoute qu'une couche d'attestation/récupération locale,
 *   jamais une identité E2EE alternative ;
 * - Windows délègue au chemin existant, iOS au provider passkey WebAuthn.
 */
import { iosPasskeyProvider } from '@/platforms/ios/iosPasskeyProvider';
import { windowsPasskeyProvider, isWindowsWeb } from '@/platforms/windows/windowsPasskeyProvider';
import { isIosRuntime } from '@/platforms/ios/capacitorBridge';
import { androidDeviceProvider } from '@/platforms/android/androidDeviceProvider';
import { isAndroidRuntime } from '@/platforms/android/androidRuntime';

export type DevicePlatformKind = 'ios' | 'android' | 'windows' | 'generic';

export interface DevicePlatformProvider {
  platform: DevicePlatformKind;
  /** Authentificateur plateforme utilisable dans ce runtime. */
  isSupported(): Promise<boolean>;
  /** Une credential locale est-elle déjà enregistrée pour ce device ? */
  getStatus(deviceId: string | null): Promise<boolean>;
  /** Scelle le coffre de récupération du device déjà approuvé + bound. */
  register(args: { userId: string; deviceId: string }): Promise<void>;
  /** Restaure le device existant après purge du stockage navigateur. */
  recover(userId: string): Promise<string>;
}

const genericProvider: DevicePlatformProvider = {
  platform: 'generic',
  isSupported: async () => false,
  getStatus: async () => false,
  register: async () => { throw new Error('DEVICE_PROVIDER_UNSUPPORTED'); },
  recover: async () => { throw new Error('DEVICE_PROVIDER_UNSUPPORTED'); },
};

export function detectDevicePlatformKind(): DevicePlatformKind {
  if (isIosRuntime()) return 'ios';
  if (isAndroidRuntime()) return 'android';
  if (isWindowsWeb()) return 'windows';
  return 'generic';
}

export function resolveDevicePlatformProvider(): DevicePlatformProvider {
  switch (detectDevicePlatformKind()) {
    case 'ios':
      return iosPasskeyProvider;
    case 'android':
      return androidDeviceProvider;
    case 'windows':
      return windowsPasskeyProvider;
    default:
      return genericProvider;
  }
}
