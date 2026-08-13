import { secureGetCriticalSecret, secureSetCriticalSecret } from '@/lib/secureStore';
import { isAndroidRuntime } from '@/platforms/android/androidRuntime';

const PREFIX = 'android.device-id-anchor:';
const DEVICE_ID_RE = /^dev_[a-f0-9]{32}$/;

export async function readAndroidDeviceIdAnchor(storageKey: string): Promise<string | null> {
  if (!isAndroidRuntime()) return null;
  try {
    const value = await secureGetCriticalSecret(`${PREFIX}${storageKey}`);
    return value && DEVICE_ID_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeAndroidDeviceIdAnchor(storageKey: string, deviceId: string): Promise<boolean> {
  if (!isAndroidRuntime() || !DEVICE_ID_RE.test(deviceId)) return false;
  try {
    await secureSetCriticalSecret(`${PREFIX}${storageKey}`, deviceId);
    return await readAndroidDeviceIdAnchor(storageKey) === deviceId;
  } catch {
    return false;
  }
}
