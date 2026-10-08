import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import {
  DEFAULT_DISCOVERY,
  discoveryPayload,
  newsDiscoveryPayload,
  type DiscoveryPreferences,
  type NewsDiscoveryPreferences,
} from '@/lib/discovery';

export function useDiscoveryPreferences() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['discovery-preferences', user?.id], enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase.from('discovery_preferences' as never)
        .select('ads_profile,ads_activity,ads_location,ads_location_auto,local_media,country,region,city,updated_at')
        .eq('user_id', user!.id).maybeSingle();
      if (error) throw error;
      return data ? data as DiscoveryPreferences : DEFAULT_DISCOVERY;
    }, staleTime: 30_000, retry: false,
  });
}

export function useSaveDiscoveryPreferences() {
  const { user } = useAuth();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: async (value: DiscoveryPreferences) => {
      if (!user) throw new Error('Connexion requise');
      const { data, error } = await supabase.rpc('set_discovery_preferences' as never,
        { p_preferences: discoveryPayload(value) } as never);
      if (error) throw error;
      return { preferences: data as unknown as DiscoveryPreferences, userId: user.id };
    },
    onSuccess: ({ preferences: value, userId }) => {
      // A response from an old login must not populate the next account's cache.
      if (user?.id !== userId) return;
      cache.setQueryData(['discovery-preferences', userId], value);
      // Remove displayed stale targeting immediately; no optimistic consent.
      cache.setQueriesData({ queryKey: ['active-ads'] }, []);
      void cache.invalidateQueries({ queryKey: ['active-ads'] });
      void cache.invalidateQueries({ queryKey: ['partner-media'] });
      void cache.invalidateQueries({ queryKey: ['ad-audience'] });
      cache.removeQueries({ queryKey: ['ad-location', userId] });
    },
  });
}

export function useSaveNewsDiscoveryPreferences() {
  const { user } = useAuth();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: async (value: NewsDiscoveryPreferences) => {
      if (!user) throw new Error('Connexion requise');
      const { data, error } = await supabase.rpc('set_news_discovery_preferences' as never,
        { p_preferences: newsDiscoveryPayload(value) } as never);
      if (error) throw error;
      return { preferences: data as unknown as DiscoveryPreferences, userId: user.id };
    },
    onSuccess: ({ preferences: value, userId }) => {
      if (user?.id !== userId) return;
      cache.setQueryData(['discovery-preferences', userId], value);
      void cache.invalidateQueries({ queryKey: ['partner-media'] });
      // The selected news zone can also be reused by an already-consented local-ad setting.
      void cache.invalidateQueries({ queryKey: ['active-ads'] });
      cache.removeQueries({ queryKey: ['ad-location', userId] });
    },
  });
}
