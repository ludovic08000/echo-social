import { secureGetCriticalSecret, secureRemoveCriticalSecret, secureSetCriticalSecret } from '@/lib/secureStore';
import { peekCurrentDeviceId, setCurrentDeviceId, setCurrentDeviceUserScope } from '@/lib/messaging/currentDevice';
import { deviceApi } from '@/lib/api/deviceApi';
import { readAndroidDeviceIdAnchor } from './androidDeviceIdAnchor';
import { androidDeviceIdStorageKey } from './androidDeviceReuse';
import { restoreAndroidDeviceVault } from './androidDeviceVault';
import { isAndroidRuntime, isNativeAndroidRuntime } from './androidRuntime';

export const androidDeviceProvider = {
  platform: 'android' as const,
  isSupported: async () => isAndroidRuntime(),
  getStatus: async (deviceId: string | null) => Boolean(
    deviceId && await secureGetCriticalSecret(`android.device-credential:${deviceId}`) === deviceId,
  ),
  register: async ({ userId, deviceId }: { userId: string; deviceId: string }) => {
    await secureSetCriticalSecret(`android.device-credential:${deviceId}`, deviceId);
  },
  recover: async (userId: string) => {
    const deviceId = await readAndroidDeviceIdAnchor(androidDeviceIdStorageKey(userId));
    if (!deviceId) throw new Error('ANDROID_DEVICE_RECOVERY_NOT_FOUND');
    setCurrentDeviceUserScope(userId);
    setCurrentDeviceId(deviceId);
    if (!await restoreAndroidDeviceVault(userId)) throw new Error('ANDROID_DEVICE_VAULT_RECOVERY_REQUIRED');
    await deviceApi.prepareKeys(userId);
    return deviceId;
  },
  isNative: isNativeAndroidRuntime,
  getSecret: secureGetCriticalSecret,
  setSecret: secureSetCriticalSecret,
  removeSecret: secureRemoveCriticalSecret,
  currentDeviceId: peekCurrentDeviceId,
};
