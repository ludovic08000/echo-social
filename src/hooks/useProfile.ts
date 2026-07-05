import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { useAuth } from '@/lib/auth';

export interface FieldVisibility {
  date_of_birth: 'public' | 'friends' | 'only_me';
  city: 'public' | 'friends' | 'only_me';
  education: 'public' | 'friends' | 'only_me';
  work: 'public' | 'friends' | 'only_me';
  relationship_status: 'public' | 'friends' | 'only_me';
  interests: 'public' | 'friends' | 'only_me';
}

export interface Profile {
  id: string;
  user_id: string;
  name: string;
  avatar_url: string | null;
  cover_url: string | null;
  cover_position_y: number | null;
  bio: string | null;
  city: string | null;
  website_url: string | null;
  date_of_birth: string | null;
  profile_type: string | null;
  education_level: string | null;
  education_city: string | null;
  work: string | null;
  relationship_status: string | null;
  interests: string[] | null;
  field_visibility: FieldVisibility | null;
  mood_emoji: string | null;
  mood_text: string | null;
  mood_updated_at: string | null;
  profile_music_url: string | null;
  is_creator: boolean;
  creator_since: string | null;
  creator_tier: string | null;
  profile_bg_url: string | null;
  feed_bg_url: string | null;
  age_verified: boolean;
  age_verification_status: string;
  created_at: string;
  updated_at: string;
}

export function useProfile(userId?: string) {
  const { user } = useAuth();
  const targetUserId = userId || user?.id;

  return useQuery({
    queryKey: ['profile', targetUserId],
    queryFn: async () => {
      if (!targetUserId) return null;
      
      const { data, error } = await supabase
        .from('profiles')
        .select('id, user_id, name, avatar_url, bio, created_at, updated_at, cover_url, date_of_birth, city, website_url, profile_type, cover_position_y, education_level, education_city, work, field_visibility, relationship_status, interests, mood_emoji, mood_text, mood_updated_at, profile_music_url, is_creator, creator_since, creator_tier, profile_bg_url, feed_bg_url, age_verified, age_verification_status, onboarding_completed, onboarding_step')
        .eq('user_id', targetUserId)
        .maybeSingle();

      if (error) throw error;
      if (!data) return null;
      return {
        ...data,
        field_visibility: data.field_visibility as unknown as FieldVisibility | null,
      } as Profile;
    },
    enabled: !!targetUserId,
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (updates: Partial<Pick<Profile, 'name' | 'bio' | 'avatar_url' | 'cover_url' | 'cover_position_y' | 'city' | 'website_url' | 'education_level' | 'education_city' | 'date_of_birth' | 'work' | 'relationship_status' | 'interests' | 'field_visibility' | 'profile_bg_url' | 'feed_bg_url'>>) => {
      if (!user) throw new Error('Not authenticated');

      // Cast field_visibility for Supabase compatibility
      const supabaseUpdates = {
        ...updates,
        field_visibility: updates.field_visibility ? (updates.field_visibility as unknown as Json) : undefined,
      };

      const { data, error } = await supabase
        .from('profiles')
        .update(supabaseUpdates)
        .eq('user_id', user.id)
        .select('id, user_id, name, avatar_url, bio, created_at, updated_at, cover_url, date_of_birth, city, website_url, profile_type, cover_position_y, education_level, education_city, work, field_visibility, relationship_status, interests, mood_emoji, mood_text, mood_updated_at, profile_music_url, is_creator, creator_since, creator_tier, profile_bg_url, feed_bg_url, age_verified, age_verification_status, onboarding_completed, onboarding_step')
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile', user?.id] });
    },
  });
}
