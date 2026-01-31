import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface NotificationSettings {
  id: string;
  user_id: string;
  likes_enabled: boolean;
  comments_enabled: boolean;
  friend_requests_enabled: boolean;
  messages_enabled: boolean;
  story_views_enabled: boolean;
  close_friends_posts_enabled: boolean;
  email_notifications_enabled: boolean;
  created_at: string;
  updated_at: string;
}

const defaultSettings: Omit<NotificationSettings, 'id' | 'user_id' | 'created_at' | 'updated_at'> = {
  likes_enabled: true,
  comments_enabled: true,
  friend_requests_enabled: true,
  messages_enabled: true,
  story_views_enabled: true,
  close_friends_posts_enabled: true,
  email_notifications_enabled: false,
};

export function useNotificationSettings() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['notification-settings'],
    queryFn: async () => {
      if (!user) return null;

      const { data, error } = await supabase
        .from('notification_settings')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) throw error;

      // Return existing settings or default
      if (data) return data as NotificationSettings;

      // Create default settings if none exist
      const { data: newSettings, error: insertError } = await supabase
        .from('notification_settings')
        .insert({
          user_id: user.id,
          ...defaultSettings,
        })
        .select()
        .single();

      if (insertError) throw insertError;
      return newSettings as NotificationSettings;
    },
    enabled: !!user,
  });
}

export function useUpdateNotificationSettings() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (updates: Partial<Omit<NotificationSettings, 'id' | 'user_id' | 'created_at' | 'updated_at'>>) => {
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('notification_settings')
        .update(updates)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notification-settings'] });
    },
  });
}
