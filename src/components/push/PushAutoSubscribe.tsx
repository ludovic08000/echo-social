import { useEffect } from 'react';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import { useAuth } from '@/lib/auth';

/**
 * Silently re-subscribes to push notifications when:
 * - user is authenticated
 * - browser already granted Notification permission previously
 * Does NOT prompt the user — that's done explicitly from the Notifications page.
 */
export function PushAutoSubscribe() {
  const { user } = useAuth();
  const { isSupported, subscribe } = usePushNotifications();

  useEffect(() => {
    if (!user || !isSupported) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;

    // Defer so it never blocks first paint
    const t = setTimeout(() => { void subscribe(); }, 2500);
    return () => clearTimeout(t);
  }, [user, isSupported, subscribe]);

  return null;
}
