import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import type { IdentityKeyPair } from './keyManager';
import {
  x3dhRespond as respondWithAccountPrekey,
  x3dhRespondForDevice,
  type X3DHInitialMessage,
} from './x3dh';

/**
 * Compatibility entry point used by the conversation-level E2EE hook.
 *
 * A message carrying opkId was created from a device-scoped 4-DH bundle. It
 * MUST be answered with the matching device SPK and OPK private keys. Calling
 * the account-wide 3-DH responder would derive a different shared secret and
 * make the first ciphertext permanently undecryptable.
 */
export async function x3dhRespond(
  myKeys: IdentityKeyPair,
  myUserId: string,
  initialMessage: X3DHInitialMessage,
): Promise<{ sharedSecret: ArrayBuffer; spkKeyPair: CryptoKeyPair }> {
  if (initialMessage.opkId !== undefined) {
    if (isDeviceIdTemporary()) {
      throw new Error('X3DH_DEVICE_ID_NOT_STABLE');
    }
    const deviceId = getCurrentDeviceId();
    if (!deviceId || deviceId.length < 16) {
      throw new Error('X3DH_DEVICE_ID_MISSING');
    }
    return x3dhRespondForDevice(myKeys, myUserId, deviceId, initialMessage);
  }

  return respondWithAccountPrekey(myKeys, myUserId, initialMessage);
}
