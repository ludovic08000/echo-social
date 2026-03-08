import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const CREATOR_REVENUE_THRESHOLD = 100_000;

export function usePlatformUserCount() {
  return useQuery({
    queryKey: ['platform-user-count'],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true });
      if (error) throw error;
      return count ?? 0;
    },
    staleTime: 5 * 60 * 1000, // cache 5 min
  });
}

export function useIsCreatorRevenueEnabled() {
  const { data: count = 0, isLoading } = usePlatformUserCount();
  return {
    enabled: count >= CREATOR_REVENUE_THRESHOLD,
    userCount: count,
    threshold: CREATOR_REVENUE_THRESHOLD,
    loading: isLoading,
  };
}
