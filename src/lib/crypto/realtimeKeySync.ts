import { supabase } from '@/integrations/supabase/client';
import { ensureAutoKeyProvisioning, resetAutoKeyProvisioningCache } from '@/lib/crypto/autoKeyProvisioning';
import { logCryptoError, logCryptoException } from '@/lib/crypto/errorLogger';
import { getCurrentDeviceId } from '@/lib/messaging/currentDevice';

export interface RealtimeKeySyncHandle {
  stop: () => void;
}

export interface RealtimeKeySyncOptions {
  onProvision?: (reason: string) => void;
}

const DEBOUNCE_MS = 1200;

export function startRealtimeKeySync(userId: string, options: RealtimeKeySyncOptions = {}): RealtimeKeySyncHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleProvision = (reason: string, force = false) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      options.onProvision?.(reason);
      void ensureAutoKeyProvisioning(userId, { reason, force }).catch((err) => {
        logCryptoException('key.rotate', err, {
          severity: 'warning',
          myDeviceId: getCurrentDeviceId(),
          metadata: { userId, reason },
        });
      });
    }, DEBOUNCE_MS);
  };

  const channel = supabase
    .channel(`e2ee-key-sync:${userId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'user_public_keys', filter: `user_id=eq.${userId}` },
      () => {
        resetAutoKeyProvisioningCache(userId);
        scheduleProvision('realtime_user_public_keys', true);
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'user_devices', filter: `user_id=eq.${userId}` },
      () => {
        resetAutoKeyProvisioningCache(userId);
        scheduleProvision('realtime_user_devices', true);
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'device_signed_prekeys', filter: `user_id=eq.${userId}` },
      () => {
        resetAutoKeyProvisioningCache(userId);
        scheduleProvision('realtime_device_signed_prekeys', true);
      },
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'device_one_time_prekeys', filter: `user_id=eq.${userId}` },
      () => scheduleProvision('realtime_device_one_time_prekeys'),
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        logCryptoError({
          severity: 'info',
          context: 'key.fetch',
          errorCode: 'REALTIME_KEY_SYNC_SUBSCRIBED',
          errorMessage: 'Realtime E2EE key sync subscribed',
          myDeviceId: getCurrentDeviceId(),
          metadata: { userId },
        });
      }
    });

  scheduleProvision('realtime_key_sync_boot');

  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      void supabase.removeChannel(channel).catch(() => {});
    },
  };
}
