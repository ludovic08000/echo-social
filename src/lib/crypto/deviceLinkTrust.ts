import { fetchVerifiedDeviceList } from './signedDeviceList';
import { peekDeviceSignedPrekey } from './x3dh';

/**
 * Aegis trust is rooted in the stable account Ed25519 key. Registration
 * authorizes this DeviceID's Ed25519/X25519 keys, and SPK validation proves
 * that the authorized route can complete a fresh X3DH bootstrap.
 */
export async function ensureApprovedDeviceTrust(
  userId: string,
  deviceId: string,
): Promise<number> {
  if (!userId || !deviceId) throw new Error('DEVICE_TRUST_INPUT_INVALID');
  const [verified, spk] = await Promise.all([
    fetchVerifiedDeviceList(userId),
    peekDeviceSignedPrekey(userId, deviceId).catch(() => null),
  ]);
  const result = verified.verifications.find((entry) => entry.deviceId === deviceId);
  const device = verified.trusted.find((entry) => entry.deviceId === deviceId);
  if (!result?.ok) {
    throw new Error(`DEVICE_IDENTITY_UNVERIFIED:${result?.reason ?? 'MISSING'}`);
  }
  if (!device?.isRoutable) throw new Error('DEVICE_ROUTE_NOT_AUTHORIZED');
  if (!spk) throw new Error('DEVICE_SIGNED_PREKEY_UNAVAILABLE');
  return 0;
}

export async function repairApprovedDeviceTrust(
  userId: string,
): Promise<number> {
  const verified = await fetchVerifiedDeviceList(userId);
  if (verified.trusted.length !== verified.verifications.length) {
    throw new Error('DEVICE_REGISTRY_CONTAINS_INVALID_IDENTITY');
  }
  return 0;
}

export async function finalizeLinkedDeviceAfterRestore(
  userId: string,
  deviceId: string,
): Promise<boolean> {
  await ensureApprovedDeviceTrust(userId, deviceId);
  try {
    window.dispatchEvent(new CustomEvent('forsure:aegis-route-ready', {
      detail: { reason: 'sesame_device_ready', deviceId },
    }));
    window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
  } catch {
    // Event delivery is best-effort outside browsers.
  }
  return true;
}
