import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useRealtimeNotificationSound } from '@/hooks/useNotificationSounds';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

// Module-level guard: ensure only ONE realtime channel exists per user across the entire app,
// even if the hook is mounted multiple times or re-rendered.
let activeChannelUserId: string | null = null;
const seenNotificationIds = new Set<string>();

/**
 * Global hook: listens for new notifications in realtime and plays a sound.
 * Also plays a sound on initial login if there are unread notifications/messages.
 */
export function useRealtimeNotifications() {
  const { user } = useAuth();
  const enqueueSound = useRealtimeNotificationSound();
  const queryClient = useQueryClient();
  const loginSoundPlayed = useRef(false);

  // Play sound on login if unread notifications or messages exist
  useEffect(() => {
    if (!user || loginSoundPlayed.current) return;
    loginSoundPlayed.current = true;

    const checkUnread = async () => {
      try {
        const [{ count: unreadNotifs }] = await Promise.all([
          supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .is('read_at', null),
        ]);

        if ((unreadNotifs || 0) > 0) {
          setTimeout(() => enqueueSound('message'), 500);
        }
      } catch {}
    };
    checkUnread();
  }, [user]);

  // Reset on logout
  useEffect(() => {
    if (!user) loginSoundPlayed.current = false;
  }, [user]);

  // Keep latest callbacks in refs so the realtime subscription stays stable
  const enqueueSoundRef = useRef(enqueueSound);
  const queryClientRef = useRef(queryClient);
  useEffect(() => {
    enqueueSoundRef.current = enqueueSound;
    queryClientRef.current = queryClient;
  }, [enqueueSound, queryClient]);

  useEffect(() => {
    if (!user) return;

    // Guard against double subscription (StrictMode, parallel mounts)
    if (activeChannelUserId === user.id) return;
    activeChannelUserId = user.id;

    const channel = supabase
      .channel(`global-notifications-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`,
        },
        async (payload) => {
          const row = payload.new as any;

          // Dedupe by notification id (Realtime can fire duplicate events on reconnect)
          const notifId: string | undefined = row?.id;
          if (notifId) {
            if (seenNotificationIds.has(notifId)) return;
            seenNotificationIds.add(notifId);
            // Cap memory: keep only last 200 ids
            if (seenNotificationIds.size > 200) {
              const first = seenNotificationIds.values().next().value;
              if (first) seenNotificationIds.delete(first);
            }
          }

          const type: string = row?.type;
          const actorId: string | undefined = row?.actor_id;

          // Fetch sender display name (non-blocking, best-effort)
          let senderName: string | undefined;
          if (actorId) {
            try {
              const { data } = await supabase
                .from('profiles')
                .select('name')
                .eq('id', actorId)
                .maybeSingle();
              if (data?.name) senderName = data.name;
            } catch {}
          }

          // Map notification type → sound category
          let category: string | undefined;
          if (type === 'message') category = 'message';
          else if (type === 'friend_request' || type === 'friend_accepted') category = 'friend_request';
          else if (type === 'comment') category = 'comment';
          else if (type === 'like' || type === 'reaction') category = 'like';

          // Special handling: new device linked to account → security toast
          if (type === 'new_device') {
            const meta = (row?.metadata ?? {}) as { device_name?: string; platform?: string };
            const label = meta.device_name || meta.platform || 'Appareil inconnu';
            toast.warning('Nouvel appareil connecté', {
              description: `${label} vient de se connecter à votre compte. Vérifiez immédiatement.`,
              duration: 10000,
              action: {
                label: 'Vérifier',
                onClick: () => { window.location.href = '/settings?tab=devices'; },
              },
            });
            category = 'friend_request';
          }

          enqueueSoundRef.current(category, senderName);
          queryClientRef.current.invalidateQueries({ queryKey: ['notifications'] });
        }
      )
      .subscribe();

    return () => {
      if (activeChannelUserId === user.id) {
        activeChannelUserId = null;
      }
      supabase.removeChannel(channel);
    };
  }, [user?.id]);
}
