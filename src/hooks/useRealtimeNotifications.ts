import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { useRealtimeNotificationSound } from '@/hooks/useNotificationSounds';
import { useQueryClient } from '@tanstack/react-query';

/**
 * Global hook: listens for new notifications in realtime and plays a sound.
 * Covers messages, friend requests, comments (post replies), likes, etc.
 */
export function useRealtimeNotifications() {
  const { user } = useAuth();
  const playSound = useRealtimeNotificationSound();
  const queryClient = useQueryClient();

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
          // Map notification type to sound category
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
          // Refresh notification counts
          queryClient.invalidateQueries({ queryKey: ['notifications'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, playSound, queryClient]);
}
