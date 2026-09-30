import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { writeRuntimePrivacyPreferences } from '@/lib/privacyPreferences';

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

export type PrivacySettingsUpdate = Partial<Omit<
  PrivacySettings,
  'id' | 'user_id' | 'created_at' | 'updated_at'
>>;

function updateRuntimeCache(settings: PrivacySettings) {
  writeRuntimePrivacyPreferences(settings.user_id, {
    ghostMode: settings.ghost_mode,
    analyticsEnabled: settings.analytics_enabled,
    onlineStatusVisibility: settings.online_status_visibility,
  });
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
        const created = newSettings as PrivacySettings;
        updateRuntimeCache(created);
        return created;
      }

      const settings = data as PrivacySettings;
      updateRuntimeCache(settings);
      return settings;
    },
    enabled: !!user,
  });
}

export function useUpdatePrivacySettings() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (updates: PrivacySettingsUpdate) => {
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('privacy_settings')
        .upsert({ user_id: user.id, ...updates }, { onConflict: 'user_id' })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      const settings = data as PrivacySettings;
      updateRuntimeCache(settings);
      queryClient.setQueryData(['privacy-settings', user?.id], settings);
      queryClient.invalidateQueries({ queryKey: ['privacy-settings', user?.id] });
    },
  });
}
