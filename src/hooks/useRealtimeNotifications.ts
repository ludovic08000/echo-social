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
  const playSound = useRealtimeNotificationSound();
  const queryClient = useQueryClient();
  const loginSoundPlayed = useRef(false);

  // Play sound on login if unread notifications or messages exist
  useEffect(() => {
    if (!user || loginSoundPlayed.current) return;
    loginSoundPlayed.current = true;

    const checkUnread = async () => {
      try {
        const [{ count: unreadNotifs }, { data: convos }] = await Promise.all([
          supabase
            .from('notifications')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', user.id)
            .is('read_at', null),
          supabase
            .from('conversation_participants')
            .select('conversation_id, last_read_at')
            .eq('user_id', user.id),
        ]);

        if ((unreadNotifs || 0) > 0) {
          // Small delay so audio context is unlocked by user interaction
          setTimeout(() => playSound('message'), 500);
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
        (payload) => {
          const type = (payload.new as any)?.type;
          if (type === 'message') {
            playSound('message');
          } else if (type === 'friend_request' || type === 'friend_accepted') {
            playSound('friend_request');
          } else if (type === 'comment') {
            playSound('comment');
          } else if (type === 'like' || type === 'reaction') {
            playSound('like');
          } else {
            playSound();
          }
          queryClient.invalidateQueries({ queryKey: ['notifications'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, playSound, queryClient]);
}
