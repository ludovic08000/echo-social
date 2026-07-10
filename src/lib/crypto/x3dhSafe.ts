import { getCurrentDeviceId, isDeviceIdTemporary } from '@/lib/messaging/currentDevice';
import type { IdentityKeyPair } from './keyManager';
import {
  x3dhInitiate as initiateWithDeviceBundle,
  x3dhRespondForDevice,
  generateAndUploadDeviceSignedPrekey,
  refreshDeviceSignedPrekeyIfNeeded,
  refillDeviceOneTimePrekeysIfNeeded,
  type X3DHInitialMessage,
  type X3DHPrekeyBundle,
  type X3DHResult,
} from './x3dh';

export class LegacyX3DHDisabledError extends Error {
  constructor(reason: 'ACCOUNT_BUNDLE' | 'MISSING_OPK') {
    super(`X3DH_LEGACY_DISABLED: ${reason}`);
    this.name = 'LegacyX3DHDisabledError';
  }
}

function requireStableCurrentDeviceId(): string {
  if (isDeviceIdTemporary()) {
    throw new Error('X3DH_DEVICE_ID_NOT_STABLE');
  }

  const deviceId = getCurrentDeviceId();
  if (!deviceId || deviceId.length < 16) {
    throw new Error('X3DH_DEVICE_ID_MISSING');
  }

  return deviceId;
}

function assertCurrentDeviceBundle(bundle: X3DHPrekeyBundle): void {
  if (
    !bundle.oneTimePrekey ||
    !Number.isSafeInteger(bundle.oneTimePrekeyId) ||
    (bundle.oneTimePrekeyId as number) <= 0
  ) {
    throw new LegacyX3DHDisabledError('MISSING_OPK');
  }
}

/**
 * Current X3DH initiator path: device-scoped signed prekey + mandatory OPK.
 * Account-wide 3-DH bundles are rejected instead of silently downgrading.
 */
export async function x3dhInitiate(
  myKeys: IdentityKeyPair,
  bundle: X3DHPrekeyBundle,
): Promise<X3DHResult> {
  assertCurrentDeviceBundle(bundle);
  return initiateWithDeviceBundle(myKeys, bundle);
}

/**
 * Current X3DH responder path. Every accepted initial message must carry the
 * OPK identifier proving that it was created from a device-scoped 4-DH bundle.
 */
export async function x3dhRespond(
  myKeys: IdentityKeyPair,
  myUserId: string,
  initialMessage: X3DHInitialMessage,
): Promise<{ sharedSecret: ArrayBuffer; spkKeyPair: CryptoKeyPair }> {
  if (
    !Number.isSafeInteger(initialMessage.opkId) ||
    (initialMessage.opkId as number) <= 0
  ) {
    throw new LegacyX3DHDisabledError('ACCOUNT_BUNDLE');
  }

  const deviceId = requireStableCurrentDeviceId();
  return x3dhRespondForDevice(myKeys, myUserId, deviceId, initialMessage);
}

/**
 * Compatibility name retained for callers, but provisioning is now exclusively
 * device-scoped and always replenishes the OPK pool.
 */
export async function generateAndUploadSignedPrekey(
  userId: string,
  signingPrivateKey: CryptoKey,
): Promise<{ spkId: number; publicKey: string; signature: string }> {
  const deviceId = requireStableCurrentDeviceId();
  const result = await generateAndUploadDeviceSignedPrekey(userId, deviceId, signingPrivateKey);
  await refillDeviceOneTimePrekeysIfNeeded(userId, deviceId);
  return result;
}

/**
 * Compatibility name retained for callers, but refreshes only the current
 * device route and guarantees that new handshakes have OPKs available.
 */
export async function refreshSignedPrekeyIfNeeded(
  userId: string,
  signingPrivateKey: CryptoKey,
): Promise<void> {
  const deviceId = requireStableCurrentDeviceId();
  await refreshDeviceSignedPrekeyIfNeeded(userId, deviceId, signingPrivateKey);
  await refillDeviceOneTimePrekeysIfNeeded(userId, deviceId);
}
