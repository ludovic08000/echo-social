import { supabase } from '@/integrations/supabase/client';
import { ensureOwnReceivingKeysPublished } from '@/lib/crypto/autoKeyProvisioning';

export function startRealtimeKeySync(userId: string) {
  let stopped = false;

  const trigger = () => {
    if (stopped) return;
    try {
      window.dispatchEvent(new CustomEvent('forsure-decrypt-retry'));
    } catch {}
  };

  const channel = supabase
    .channel(`e2ee-sync:${userId}`)

    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_public_keys' }, trigger)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'signed_prekeys' }, trigger)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_signed_prekeys' }, trigger)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_one_time_prekeys' }, trigger)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_devices' }, trigger)

    // 🔥 CRITIQUE : réception message + copies
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, trigger)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_device_copies' }, trigger)

    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await ensureOwnReceivingKeysPublished(userId);
        trigger();
      }
    });

  const onOnline = async () => {
    await ensureOwnReceivingKeysPublished(userId);
    trigger();
  };

  window.addEventListener('online', onOnline);
  window.addEventListener('forsure-keys-unlocked', onOnline);
  window.addEventListener('forsure-keys-restored', onOnline);

  return {
    stop() {
      stopped = true;
      supabase.removeChannel(channel);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('forsure-keys-unlocked', onOnline);
      window.removeEventListener('forsure-keys-restored', onOnline);
    }
  };
}
