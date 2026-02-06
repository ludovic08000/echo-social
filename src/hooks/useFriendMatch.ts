import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface FriendSuggestion {
  user_id: string;
  name: string;
  avatar_url: string | null;
  bio: string | null;
  city: string | null;
  profile_type: string | null;
  mutual_friends_count: number;
}

export function useFriendSuggestions(limit = 20) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['friend-suggestions', user?.id, limit],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .rpc('get_friend_suggestions', { target_user_id: user.id, limit_count: limit });
      if (error) throw error;
      return (data || []) as FriendSuggestion[];
    },
    enabled: !!user,
  });
}
