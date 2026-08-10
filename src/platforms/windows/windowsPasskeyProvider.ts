/**
 * Provider Windows (Windows Hello / WebAuthn plateforme).
 *
 * Invariant : simple façade de lecture au-dessus du module Windows existant.
 * AUCUNE logique n'est réécrite ici — `src/lib/crypto/windowsHelloDeviceRecovery.ts`
 * reste la référence stable et n'est pas modifié.
 */
import {
  getWindowsHelloRecoveryStatus,
  isWindowsHelloAvailable,
  isWindowsWeb,
  recoverCurrentWindowsHelloDevice,
  registerCurrentWindowsHelloDevice,
} from '@/lib/crypto/windowsHelloDeviceRecovery';

export const windowsPasskeyProvider = {
  platform: 'windows' as const,
  isSupported: () => isWindowsHelloAvailable(),
  getStatus: (deviceId: string | null) =>
    deviceId ? getWindowsHelloRecoveryStatus(deviceId) : Promise.resolve(false),
  register: (args: { userId: string; deviceId: string }) => registerCurrentWindowsHelloDevice(args),
  recover: (userId: string) => recoverCurrentWindowsHelloDevice(userId),
};

export { isWindowsWeb };
