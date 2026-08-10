/**
 * DeviceLifecycleCore : sélection du provider plateforme d'attestation locale.
 *
 * Invariants :
 * - le lifecycle canonique (AUTHENTICATED -> DEVICE_CREDENTIAL_CHECK ->
 *   LINK_REQUIRED/PENDING_APPROVAL -> APPROVED_LOCKED -> PIN_UNLOCK ->
 *   ACCOUNT_KEY_SYNC -> MESSAGING_READY) reste inchangé ;
 * - un provider n'ajoute qu'une couche d'attestation/récupération locale,
 *   jamais une identité E2EE alternative ;
 * - Windows délègue au chemin existant, iOS au provider Passkey WebAuthn pur web.
 */
import { iosPasskeyProvider } from '@/platforms/ios/iosPasskeyProvider';
import { windowsPasskeyProvider, isWindowsWeb } from '@/platforms/windows/windowsPasskeyProvider';
import { isIosWebRuntime } from '@/platforms/ios/iosRuntime';

export type DevicePlatformKind = 'ios' | 'windows' | 'generic';

export interface DevicePlatformProvider {
  platform: DevicePlatformKind;
  isSupported(): Promise<boolean>;
  getStatus(deviceId: string | null): Promise<boolean>;
  register(args: { userId: string; deviceId: string }): Promise<void>;
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
  if (isIosWebRuntime()) return 'ios';
  if (isWindowsWeb()) return 'windows';
  return 'generic';
}

export function resolveDevicePlatformProvider(): DevicePlatformProvider {
  switch (detectDevicePlatformKind()) {
    case 'ios':
      return iosPasskeyProvider;
    case 'windows':
      return windowsPasskeyProvider;
    default:
      return genericProvider;
  }
}
