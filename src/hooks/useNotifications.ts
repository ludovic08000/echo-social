import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { groupNotifications, type GroupedNotification } from '@/lib/feedAlgorithm';

export interface Notification {
  id: string;
  user_id: string;
  type: 'like' | 'comment' | 'sale' | 'friend_request' | 'friend_accepted' | 'message' | 'reaction' | 'story_view' | 'new_device';
  actor_id: string;
  post_id: string | null;
  read_at: string | null;
  created_at: string;
  actor: {
    name: string;
    avatar_url: string | null;
  };
}

export function useNotifications() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['notifications'],
    queryFn: async () => {
      if (!user) return [];

      const { data, error } = await supabase
        .from('notifications')
        .select(`
          id,
          user_id,
          type,
          actor_id,
          post_id,
          read_at,
          created_at
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      // Get actor profiles
      const actorIds = [...new Set(data.map(n => n.actor_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url')
        .in('user_id', actorIds);

      const profileMap = new Map(profiles?.map(p => [p.user_id, p]) || []);

      return data.map(notification => {
        const actor = profileMap.get(notification.actor_id);
        return {
          id: notification.id,
          user_id: notification.user_id,
          type: notification.type as Notification['type'],
          actor_id: notification.actor_id,
          post_id: notification.post_id,
          read_at: notification.read_at,
          created_at: notification.created_at,
          actor: {
            name: actor?.name || 'Unknown',
            avatar_url: actor?.avatar_url || null,
          },
        };
      });
    },
    enabled: !!user,
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useUnreadCount() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: async () => {
      if (!user) return 0;

      const { count, error } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .is('read_at', null);

      if (error) throw error;
      return count || 0;
    },
    enabled: !!user,
    staleTime: 30_000,
    refetchInterval: 60_000, // Check unread every 60s instead of 30s
    refetchOnWindowFocus: false,
  });
}

export function useMarkAsRead() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (notificationId?: string) => {
      if (!user) throw new Error('Not authenticated');

      if (notificationId) {
        const { error } = await supabase
          .from('notifications')
          .update({ read_at: new Date().toISOString() })
          .eq('id', notificationId);

        if (error) throw error;
      } else {
        // "Tout marquer comme lu" → on supprime carrément les notifications
        // de l'utilisateur pour vider la liste à l'écran.
        const { error } = await supabase
          .from('notifications')
          .delete()
          .eq('user_id', user.id);

        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] });
    },
  });
}

export function useGroupedNotifications() {
  const { data: notifications = [], ...rest } = useNotifications();
  const grouped = groupNotifications(notifications);
  return { data: grouped, ...rest };
}
