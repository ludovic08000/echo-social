import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export function usePushNotifications() {
  const { user } = useAuth();
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  );
  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    setIsSupported('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
  }, []);

  const subscribe = useCallback(async () => {
    if (!user || !isSupported) return false;

    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') return false;

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();

      if (!subscription) {
        // Without VAPID keys configured, we store the intent
        // Real VAPID subscription would use: registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })
        console.log('[Push] Permission granted, storing subscription intent');
      }

      // Store subscription info in database
      const subData = subscription ? JSON.parse(JSON.stringify(subscription)) : { endpoint: 'browser-notification', keys: {} };

      await supabase.from('push_subscriptions').upsert({
        user_id: user.id,
        endpoint: subData.endpoint || 'browser-notification',
        p256dh_key: subData.keys?.p256dh || null,
        auth_key: subData.keys?.auth || null,
        user_agent: navigator.userAgent,
      }, { onConflict: 'user_id,endpoint' });

      return true;
    } catch (err) {
      console.error('[Push] Subscribe error:', err);
      return false;
    }
  }, [user, isSupported]);

  const unsubscribe = useCallback(async () => {
    if (!user) return;
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();

      await supabase.from('push_subscriptions').delete().eq('user_id', user.id);
    } catch (err) {
      console.error('[Push] Unsubscribe error:', err);
    }
  }, [user]);

  return { isSupported, permission, subscribe, unsubscribe };
}
