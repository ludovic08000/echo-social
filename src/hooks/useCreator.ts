import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

export function useIsCreator(userId?: string) {
  const { loading } = useAuth();

  return useQuery({
    queryKey: ['is-creator', userId, loading ? 'loading' : 'ready'],
    queryFn: async () => {
      if (!userId) return false;
      const { data } = await supabase
        .from('profiles')
        .select('is_creator')
        .eq('user_id', userId)
        .maybeSingle();
      return data?.is_creator ?? false;
    },
    enabled: !!userId && !loading,
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

      // Start Stripe checkout — activation happens via webhook
      const { data, error } = await supabase.functions.invoke('create-checkout', {
        body: { priceId: 'price_1T8gAk6wgOEGAgcG4A12CIFZ' },
      });

      if (error) throw error;
      if (data?.url) {
        window.open(data.url, '_blank');
      }
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
