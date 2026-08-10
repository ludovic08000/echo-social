/**
 * Abstraction Secure Enclave iOS.
 *
 * Étape architecture uniquement : on constate la disponibilité de l'ancrage
 * matériel, on ne génère aucune clé et on ne modifie aucun protocole.
 */
import type { HardwareEnclaveStatus } from '@/platforms/deviceSecureProvider';
import { inspectIosBridge } from '@/platforms/ios/capacitorBridge';
import { inspectIosKeychain } from '@/platforms/ios/keychain';

export async function inspectIosSecureEnclave(): Promise<HardwareEnclaveStatus> {
  const bridge = inspectIosBridge();

  if (!bridge.isNativeIos) {
    return {
      available: false,
      backing: bridge.isIosWeb ? 'software' : 'unknown',
      reason: bridge.isIosWeb
        ? 'Runtime web iOS : enclave logicielle ACE Web (WebCrypto non extractible).'
        : 'Runtime non iOS.',
    };
  }

  const keychain = await inspectIosKeychain();
  if (!keychain.available) {
    return {
      available: false,
      backing: 'unknown',
      reason: 'Le pont Keychain natif ne répond pas ; ancrage matériel non vérifiable.',
    };
  }

  // Le plugin AegisKeychain est adossé à l'ancrage Secure Enclave côté natif.
  return {
    available: true,
    backing: 'secure-enclave',
    reason: null,
  };
}
