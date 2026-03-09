import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export interface ABTest {
  id: string;
  name: string;
  description: string | null;
  test_type: string;
  status: string;
  variant_a: Record<string, unknown>;
  variant_b: Record<string, unknown>;
  traffic_split: number;
  target_metric: string;
  results_a: { impressions: number; conversions: number; score: number };
  results_b: { impressions: number; conversions: number; score: number };
  winner: string | null;
  created_by: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export function useABTests() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const tests = useQuery({
    queryKey: ['ab-tests'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ab_tests')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as unknown as ABTest[];
    },
    enabled: !!user,
  });

  const createTest = useMutation({
    mutationFn: async (test: { name: string; description?: string; test_type: string; variant_a: Record<string, unknown>; variant_b: Record<string, unknown>; traffic_split: number; target_metric: string }) => {
      const { data, error } = await supabase.from('ab_tests').insert({
        ...test,
        created_by: user?.id,
      } as any).select().single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ab-tests'] }),
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const updates: Record<string, unknown> = { status };
      if (status === 'running') updates.started_at = new Date().toISOString();
      if (status === 'completed') updates.ended_at = new Date().toISOString();
      const { error } = await supabase.from('ab_tests').update(updates as any).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ab-tests'] }),
  });

  const deleteTest = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('ab_tests').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ab-tests'] }),
  });

  return { tests, createTest, updateStatus, deleteTest };
}

export function useAIMetrics(moduleId?: string) {
  return useQuery({
    queryKey: ['ai-metrics', moduleId],
    queryFn: async () => {
      let q = supabase
        .from('ai_metrics_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (moduleId) q = q.eq('module_id', moduleId);
      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 30000, // refresh every 30s
  });
}
