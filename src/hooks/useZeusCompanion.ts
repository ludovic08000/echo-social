import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export function useZeusSettings() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: ['zeus-settings', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data } = await supabase
        .from('zeus_user_settings')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      return data;
    },
    enabled: !!user,
  });

  const updateName = useMutation({
    mutationFn: async (customName: string) => {
      if (!user) throw new Error('Not authenticated');
      const { error } = await supabase
        .from('zeus_user_settings')
        .upsert({ user_id: user.id, custom_name: customName, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['zeus-settings'] }),
  });

  const zeusName = settings?.custom_name || 'Zeus';

  return { zeusName, settings, updateName };
}

export function useContentStrikes() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: strikes } = useQuery({
    queryKey: ['content-strikes', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data } = await supabase
        .from('content_strikes')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(10);
      return data || [];
    },
    enabled: !!user,
  });

  const unacknowledged = strikes?.filter((s: any) => !s.acknowledged_at && !s.acknowledged) || [];

  const acknowledge = useMutation({
    mutationFn: async (strikeId: string) => {
      const { error } = await (supabase as any).rpc('acknowledge_content_strike', { p_strike_id: strikeId });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['content-strikes'] }),
  });

  const acknowledgeAll = useMutation({
    mutationFn: async () => {
      const { error } = await (supabase as any).rpc('acknowledge_all_content_strikes');
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['content-strikes'] }),
  });

  return { strikes, unacknowledged, acknowledge, acknowledgeAll };
}

export function usePostModeration() {
  return useMutation({
    mutationFn: async ({ postId, body, imageUrl }: { postId: string; body: string; imageUrl?: string }) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return null;

      const { data, error } = await supabase.functions.invoke('zeus', {
        body: { domain: 'post-moderation', postId, text: body, imageUrl },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (error) {
        console.warn('Post moderation check failed:', error);
        return null;
      }
      return data;
    },
  });
}

// Get Zeus agent ID
export function useZeusAgentId() {
  return useQuery({
    queryKey: ['zeus-agent-id'],
    queryFn: async () => {
      const { data } = await supabase
        .from('ai_agents')
        .select('id')
        .eq('slug', 'zeus-companion')
        .eq('is_active', true)
        .single();
      return data?.id || null;
    },
    staleTime: Infinity,
  });
}
