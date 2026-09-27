import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface NewUser {
  user_id: string;
  name: string;
  avatar_url: string | null;
  bio: string | null;
  city: string | null;
  created_at: string;
}

export function useNewUsers(limit = 30) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['new-users', user?.id, limit],
    queryFn: async () => {
      if (!user) return [];

      const { data, error } = await supabase.rpc('get_friend_suggestions', {
        target_user_id: user.id,
        limit_count: Math.max(1, Math.min(limit, 50)),
      });

      if (error) throw error;
      return (data || []) as unknown as NewUser[];
    },
    enabled: !!user,
    staleTime: 2 * 60_000,
  });
}
