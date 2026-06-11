import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface WellbeingScore {
  id: string;
  user_id: string;
  score: number;
  screen_time_score: number;
  social_balance_score: number;
  content_diversity_score: number;
  break_frequency_score: number;
  positivity_score: number;
  factors: Record<string, any>;
  computed_at: string;
}

export function useWellbeingScore() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['wellbeing-score', user?.id],
    enabled: !!user,
    queryFn: async (): Promise<WellbeingScore | null> => {
      const { data, error } = await supabase
        .from('wellbeing_scores')
        .select('*')
        .eq('user_id', user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as WellbeingScore | null;
    },
  });
}

export function useComputeWellbeing() {
  const qc = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('wellbeing-compute', {
        body: {},
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wellbeing-score', user?.id] });
    },
  });
}
