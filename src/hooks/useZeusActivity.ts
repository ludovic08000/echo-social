import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { loadZeusActivity } from '@/lib/zeusActivity';

export function useZeusActivity() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['zeus-activity', user?.id],
    queryFn: ()=>loadZeusActivity(user?.id),
    enabled: Boolean(user),
    staleTime: 10_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
}
