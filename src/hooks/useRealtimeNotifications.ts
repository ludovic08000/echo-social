import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useRealtimeNotificationSound } from '@/hooks/useNotificationSounds';
import { useQueryClient } from '@tanstack/react-query';

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

  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('global-notifications')
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
          const type: string = row?.type;
          const actorId: string | undefined = row?.actor_id;

          // Fetch sender display name (non-blocking, best-effort)
          let senderName: string | undefined;
          if (actorId) {
            try {
              const { data } = await supabase
                .from('profiles')
                .select('display_name')
                .eq('id', actorId)
                .maybeSingle();
              if (data?.display_name) senderName = data.display_name;
            } catch {}
          }

          // Map notification type → sound category
          let category: string | undefined;
          if (type === 'message') category = 'message';
          else if (type === 'friend_request' || type === 'friend_accepted') category = 'friend_request';
          else if (type === 'comment') category = 'comment';
          else if (type === 'like' || type === 'reaction') category = 'like';

          enqueueSound(category, senderName);
          queryClient.invalidateQueries({ queryKey: ['notifications'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, enqueueSound, queryClient]);
}
