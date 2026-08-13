import { loadDeviceIdentity } from '@/lib/crypto/deviceIdentity';
import { loadDeviceKxKey } from '@/lib/crypto/deviceKx';
import { peekCurrentDeviceId, setCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { readAndroidDeviceIdAnchor } from './androidDeviceIdAnchor';
import { isAndroidRuntime } from './androidRuntime';

const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;
export const androidDeviceIdStorageKey = (userId: string) => `forsure_device_id:${userId}`;

export async function resolveExistingAndroidDevice(userId: string): Promise<string | null> {
  if (!isAndroidRuntime()) return null;
  const current = peekCurrentDeviceId();
  if (current && DEVICE_ID_RE.test(current)) return current;
  return readAndroidDeviceIdAnchor(androidDeviceIdStorageKey(userId));
}

export async function adoptReusableAndroidDevice(userId: string): Promise<string | null> {
  const deviceId = await resolveExistingAndroidDevice(userId);
  if (!deviceId) return null;
  const [identity, kx] = await Promise.all([
    loadDeviceIdentity(userId, deviceId),
    loadDeviceKxKey(deviceId, userId),
  ]);
  if (!identity || !kx) return null;
  return peekCurrentDeviceId() === deviceId ? deviceId : setCurrentDeviceId(deviceId);
}
