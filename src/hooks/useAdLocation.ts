import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { DiscoveryPreferences } from '@/lib/discovery';

export function useAdLocation(userId: string | undefined, sessionKey: string | null, preferences: DiscoveryPreferences | undefined) {
  return useQuery({
    queryKey: ['ad-location', userId, sessionKey, preferences?.updated_at],
    enabled: !!userId && !!sessionKey && preferences?.ads_location === true && preferences.ads_location_auto === true
      && !preferences.country && !preferences.region && !preferences.city,
    queryFn: async ({ signal }) => {
      const { data, error } = await supabase.functions.invoke('ad-location', { body: {}, signal });
      if (error) throw error;
      return data as { location: { country: string; region: string | null; city: string | null; source: string; expiresAt?: string } | null };
    },
    // Independent of feed/creative fetch; never wait for geolocation to render posts.
    staleTime: 10 * 60_000, gcTime: 15 * 60_000,
    refetchInterval: query => {
      // An expired successful result may remain cached after an error. Never poll that failure every second.
      if (query.state.status === 'error') return 10 * 60_000;
      const expiresAt = Date.parse(query.state.data?.location?.expiresAt ?? '');
      return Number.isFinite(expiresAt) ? Math.max(1000, Math.min(10 * 60_000, expiresAt - Date.now() + 100)) : 10 * 60_000;
    },
    refetchIntervalInBackground: false, retry: false,
  });
}
