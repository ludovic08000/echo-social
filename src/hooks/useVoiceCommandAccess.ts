import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export function useVoiceCommandAccess() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['voice-command-access', user?.id],
    enabled: Boolean(user),
    queryFn: async () => {
      if (!user) return false;
      const { data, error } = await supabase.rpc('voice_command_access');
      if (error) throw error;
      return data === true;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
