import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

let cachedVapidKey: string | null = null;
async function getVapidPublicKey(): Promise<string | null> {
  if (cachedVapidKey) return cachedVapidKey;
  try {
    const { data, error } = await supabase.functions.invoke('vapid-public-key');
    if (error || !data?.publicKey) return null;
    cachedVapidKey = data.publicKey as string;
    return cachedVapidKey;
  } catch {
    return null;
  }
}

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
        const vapidKey = await getVapidPublicKey();
        if (!vapidKey) {
          console.warn('[Push] VAPID public key unavailable, falling back to local notifications');
        } else {
          try {
            subscription = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(vapidKey),
            });
          } catch (e) {
            console.error('[Push] pushManager.subscribe failed:', e);
          }
        }
      }

      const subData = subscription ? JSON.parse(JSON.stringify(subscription)) : null;

      await supabase.from('push_subscriptions').upsert({
        user_id: user.id,
        endpoint: subData?.endpoint || `local-${navigator.userAgent.slice(0, 32)}`,
        p256dh: subData?.keys?.p256dh || 'pending',
        auth: subData?.keys?.auth || 'pending',
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
      if (subscription) {
        await subscription.unsubscribe();
        await supabase.from('push_subscriptions').delete()
          .eq('user_id', user.id).eq('endpoint', subscription.endpoint);
      } else {
        await supabase.from('push_subscriptions').delete().eq('user_id', user.id);
      }
    } catch (err) {
      console.error('[Push] Unsubscribe error:', err);
    }
  }, [user]);

  return { isSupported, permission, subscribe, unsubscribe };
}
