import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { ensureOwnReceivingKeysPublished } from '@/lib/crypto/autoKeyProvisioning';
import { startRealtimeKeySync } from '@/lib/crypto/realtimeKeySync';
import { installE2EESafetyGuards } from '@/lib/crypto/e2eeSafetyGuards';

const PIN_SESSION_KEY = 'forsure-pin-unlocked';

/**
 * Global E2EE device/key coordinator.
 */
export function useDeviceRegistration() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.id) return;

    // 🔥 Install browser safety guards once per session.
    // Prevents SPK-loss loops from purging ratchets/messages.
    installE2EESafetyGuards(user.id);

    let stopped = false;
    const realtime = startRealtimeKeySync(user.id);

    void supabase.rpc('update_chat_pin_mode' as any, {
      p_pin_mode: 'once_per_session',
    }).catch(() => undefined);

    const publish = async (reason: string) => {
      if (stopped) return;

      const result = await ensureOwnReceivingKeysPublished(user.id);

      if (!result.ok) {
        console.warn('[DeviceReg] key provisioning paused', {
          reason,
          result,
        });
        return;
      }

      console.info('[DeviceReg] receiving keys ready', {
        reason,
        deviceId: result.deviceId,
        status: result.status,
      });

      try {
        sessionStorage.setItem(PIN_SESSION_KEY, user.id);

        window.dispatchEvent(new CustomEvent('forsure-keys-unlocked', {
          detail: {
            userId: user.id,
            deviceId: result.deviceId,
            reason,
          },
        }));

        window.dispatchEvent(new CustomEvent('forsure-decrypt-retry', {
          detail: {
            userId: user.id,
            deviceId: result.deviceId,
            reason,
          },
        }));
      } catch {
        // browserless/test environment
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
