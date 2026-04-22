import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface PrivacySettings {
  id: string;
  user_id: string;
  profile_visibility: 'public' | 'friends' | 'private';
  posts_visibility: 'public' | 'friends' | 'private';
  friends_list_visibility: 'public' | 'friends' | 'private';
  online_status_visibility: 'everyone' | 'friends' | 'nobody';
  messages_allowed: 'everyone' | 'friends' | 'nobody';
  comments_allowed: 'everyone' | 'friends' | 'nobody';
  likes_visibility: 'public' | 'friends' | 'private';
  wall_visibility: 'everyone' | 'friends' | 'nobody';
  search_engine_indexing: boolean;
  analytics_enabled: boolean;
  ghost_mode: boolean;
  detox_schedule: any | null;
  daily_limit_minutes: number | null;
  ai_personalization_enabled: boolean;
  ai_data_sharing_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export function usePrivacySettings() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['privacy-settings', user?.id],
    queryFn: async (): Promise<PrivacySettings | null> => {
      if (!user) return null;

      const { data, error } = await supabase
        .from('privacy_settings')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) throw error;

      // If no settings exist, create default ones
      if (!data) {
        const { data: newSettings, error: insertError } = await supabase
          .from('privacy_settings')
          .insert({ user_id: user.id })
          .select()
          .single();

        if (insertError) throw insertError;
        return newSettings as PrivacySettings;
      }

      return data as PrivacySettings;
    },
    enabled: !!user,
  });
}

export function useUpdatePrivacySettings() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (updates: Partial<Omit<PrivacySettings, 'id' | 'user_id' | 'created_at' | 'updated_at'>>) => {
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('privacy_settings')
        .update(updates)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['privacy-settings', user?.id] });
    },
  });
}
