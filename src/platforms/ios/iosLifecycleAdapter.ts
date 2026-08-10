/**
 * Adaptateur de lifecycle iOS.
 *
 * Il ne réimplémente rien : il observe le lifecycle device existant et, sur iOS
 * uniquement, ancre le DeviceID dans le Keychain puis publie les métadonnées
 * plateforme. Aucun appel hors runtime iOS (Windows strictement inchangé).
 */
import { isIosRuntime } from '@/platforms/ios/capacitorBridge';
import { writeIosDeviceIdAnchor } from '@/platforms/ios/iosDeviceIdAnchor';
import { publishIosPlatformMetadata } from '@/platforms/ios/iosPlatformMetadata';
import { recordIosRpcError } from '@/platforms/ios/iosRpcErrorLog';
import { iosDeviceIdStorageKey } from '@/platforms/ios/iosDeviceIdStorageKey';

const publishedDevices = new Set<string>();

/** Idempotent, best-effort : ne doit jamais interrompre le lifecycle. */
export async function syncIosDeviceAdapter(userId: string, deviceId: string): Promise<void> {
  if (!isIosRuntime() || !userId || !deviceId) return;
  const cacheKey = `${userId}:${deviceId}`;

  try {
    await writeIosDeviceIdAnchor(iosDeviceIdStorageKey(userId), deviceId);
  } catch (error) {
    recordIosRpcError('ios.device-id-anchor', error);
  }

  if (publishedDevices.has(cacheKey)) return;
  publishedDevices.add(cacheKey);
  try {
    const ok = await publishIosPlatformMetadata(userId, deviceId);
    if (!ok) publishedDevices.delete(cacheKey);
  } catch (error) {
    publishedDevices.delete(cacheKey);
    recordIosRpcError('ios.platform-metadata', error);
  }
}

export const __test__ = {
  reset(): void {
    publishedDevices.clear();
  },
};
