import { fetchVerifiedDeviceList } from './signedDeviceList';
import { peekDeviceSignedPrekey } from './x3dh';

/**
 * Sesame trust is per DeviceID. Registration publishes a self-authenticated
 * Ed25519/X25519 binding, and SPK validation proves the route is usable.
 * There is no account root, primary device, or companion-signing repair pass.
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
  if (!result?.ok) {
    throw new Error(`DEVICE_IDENTITY_UNVERIFIED:${result?.reason ?? 'MISSING'}`);
  }
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
