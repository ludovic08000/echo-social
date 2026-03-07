import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export function useIsCreator(userId?: string) {
  return useQuery({
    queryKey: ['is-creator', userId],
    queryFn: async () => {
      if (!userId) return false;
      const { data } = await supabase
        .from('profiles')
        .select('is_creator')
        .eq('user_id', userId)
        .maybeSingle();
      return data?.is_creator ?? false;
    },
    enabled: !!userId,
  });
}

export function useCreatorSubscription() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['creator-subscription', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data } = await supabase
        .from('creator_subscriptions')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      return data;
    },
    enabled: !!user,
  });
}

export function useActivateCreator() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async () => {
      if (!user) throw new Error('Not authenticated');

      // For now, activate without payment (Stripe will be added later)
      await supabase.from('creator_subscriptions').upsert({
        user_id: user.id,
        status: 'active',
        plan: 'creator_monthly',
        price_cents: 500,
        currency: 'eur',
        current_period_start: new Date().toISOString(),
        current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      }, { onConflict: 'user_id' });

      await supabase.from('profiles').update({
        is_creator: true,
        creator_since: new Date().toISOString(),
        creator_tier: 'creator',
      }).eq('user_id', user.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['is-creator'] });
      queryClient.invalidateQueries({ queryKey: ['creator-subscription'] });
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export function useDeactivateCreator() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async () => {
      if (!user) throw new Error('Not authenticated');

      await supabase.from('creator_subscriptions').update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
      }).eq('user_id', user.id);

      await supabase.from('profiles').update({
        is_creator: false,
        creator_tier: 'free',
      }).eq('user_id', user.id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['is-creator'] });
      queryClient.invalidateQueries({ queryKey: ['creator-subscription'] });
      queryClient.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}
