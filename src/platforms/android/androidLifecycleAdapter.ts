import { writeAndroidDeviceIdAnchor } from './androidDeviceIdAnchor';
import { androidDeviceIdStorageKey } from './androidDeviceReuse';
import { isAndroidRuntime } from './androidRuntime';

export async function syncAndroidDeviceAdapter(userId: string, deviceId: string): Promise<void> {
  if (!isAndroidRuntime() || !userId || !deviceId) return;
  await writeAndroidDeviceIdAnchor(androidDeviceIdStorageKey(userId), deviceId);
}
