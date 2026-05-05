import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/integrations/supabase/client';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';
import { getOrCreateDeviceKxKey, loadDeviceKxKey } from '@/lib/crypto/deviceKx';
import { PinUnlockRequiredError } from '@/lib/crypto/keyManager';

export function useDeviceRegistration() {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.id) return;

    const run = async () => {
      const deviceId = getCurrentDeviceId();

      try {
        const { data: existing, error } = await supabase
          .from('user_devices')
          .select('device_public_key')
          .eq('user_id', user.id)
          .eq('device_id', deviceId)
          .maybeSingle();

        if (error) {
          console.error('[DeviceReg] lookup failed → STOP', error);
          return;
        }

        const serverKey = existing?.device_public_key || null;
        const local = await loadDeviceKxKey(deviceId);

        // 🔴 CAS CRITIQUE : serveur a une clé mais local ne l’a plus
        if (serverKey) {
          if (!local) {
            console.error('[DeviceReg] missing local device key → restore required');
            window.dispatchEvent(new CustomEvent('forsure:device-kx-restore-required'));
            return;
          }

          if (local.publicB64 !== serverKey) {
            console.error('[DeviceReg] device key mismatch → BLOCK');
            window.dispatchEvent(new CustomEvent('forsure:device-kx-restore-required'));
            return;
          }

          // OK → rien à faire
          return;
        }

        // 🟢 PREMIÈRE CRÉATION
        const newKey = await getOrCreateDeviceKxKey(deviceId);

        if (!newKey?.publicB64) {
          console.error('[DeviceReg] no key generated');
          return;
        }

        await supabase.from('user_devices').upsert({
          user_id: user.id,
          device_id: deviceId,
          device_public_key: newKey.publicB64,
          is_active: true,
          last_seen_at: new Date().toISOString(),
        });

        console.log('[DeviceReg] device key created');

      } catch (e) {
        if (e instanceof PinUnlockRequiredError) {
          console.warn('[DeviceReg] PIN locked → STOP');
          return;
        }

        console.error('[DeviceReg] fatal error', e);
      }
    };

    run();
  }, [user?.id]);
}
