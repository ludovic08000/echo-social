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

      // Get IDs to exclude (self + existing friends + pending requests)
      const { data: friendships } = await supabase
        .from('friendships')
        .select('requester_id, addressee_id')
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

      const excludeIds = new Set<string>([user.id]);
      friendships?.forEach(f => {
        excludeIds.add(f.requester_id);
        excludeIds.add(f.addressee_id);
      });

      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name, avatar_url, bio, city, created_at')
        .not('user_id', 'in', `(${[...excludeIds].join(',')})`)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data || []) as NewUser[];
    },
    enabled: !!user,
    staleTime: 2 * 60_000,
  });
}
