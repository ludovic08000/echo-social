import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { ensureOwnReceivingKeysPublished } from '@/lib/crypto/autoKeyProvisioning';
import { startRealtimeKeySync } from '@/lib/crypto/realtimeKeySync';

/**
 * Global E2EE device/key coordinator.
 *
 * Runs once per authenticated user and is intentionally strict:
 * - publishes/refreshes receiving material only after real keys are available;
 * - never overwrites an existing server device key if local private material is missing;
 * - starts realtime key/message/copy listeners so decrypt retry is automatic.
 */
export function useDeviceRegistration() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.id) return;

    let stopped = false;
    const realtime = startRealtimeKeySync(user.id);

    const publish = async (reason: string) => {
      if (stopped) return;
      const result = await ensureOwnReceivingKeysPublished(user.id);

      if (!result.ok) {
        console.warn('[DeviceReg] key provisioning paused', { reason, result });
        return;
      }

      console.info('[DeviceReg] receiving keys ready', { reason, deviceId: result.deviceId });
      try {
        window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
          detail: { userId: user.id, deviceId: result.deviceId, reason },
        }));
      } catch {
        // non-browser/test
      }
    };

    void publish('mount');

    const onKeysReady = () => void publish('keys-ready');
    const onOnline = () => void publish('online');

    window.addEventListener('forsure-keys-unlocked', onKeysReady);
    window.addEventListener('forsure-keys-restored', onKeysReady);
    window.addEventListener('online', onOnline);

    return () => {
      stopped = true;
      realtime.stop();
      window.removeEventListener('forsure-keys-unlocked', onKeysReady);
      window.removeEventListener('forsure-keys-restored', onKeysReady);
      window.removeEventListener('online', onOnline);
    };
  }, [user?.id]);
}
