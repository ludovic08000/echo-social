import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';

// ── Seuils globaux plateforme ──
const CREATOR_REVENUE_THRESHOLD = 100_000;
const MARKETPLACE_THRESHOLD = 10_000;

export function useIsMarketplaceEnabled() {
  const { data: count = 0, isLoading } = usePlatformUserCount();
  return {
    enabled: count >= MARKETPLACE_THRESHOLD,
    userCount: count,
    threshold: MARKETPLACE_THRESHOLD,
    loading: isLoading,
  };
}

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
    staleTime: 5 * 60 * 1000,
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

// ── Seuils individuels créateur (style TikTok) ──
export const CREATOR_THRESHOLDS = {
  followers: 10_000,       // 10K abonnés/amis
  liveViews30d: 100_000,   // 100K vues sur les lives des 30 derniers jours
  subscribers: 1_000,      // 1 000 abonnés payants (créateurs qui les suivent en premium)
  minAgeDays: 30,          // Compte de +30 jours
} as const;

export interface CreatorEligibility {
  followers: number;
  liveViews30d: number;
  subscribers: number;
  accountAgeDays: number;
  meetFollowers: boolean;
  meetLiveViews: boolean;
  meetSubscribers: boolean;
  meetAccountAge: boolean;
  eligible: boolean;
  loading: boolean;
}

export function useCreatorEligibility(): CreatorEligibility {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['creator-eligibility', user?.id],
    queryFn: async () => {
      if (!user) return null;

      // 1. Nombre d'amis (followers) acceptés
      const { count: followerCount } = await supabase
        .from('friendships')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'accepted')
        .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);

      // 2. Vues totales sur les lives des 30 derniers jours
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const { data: userLives } = await supabase
        .from('live_streams')
        .select('id, total_views')
        .eq('user_id', user.id)
        .gte('created_at', thirtyDaysAgo.toISOString());

      const liveViews30d = (userLives || []).reduce((sum, l) => sum + (l.total_views || 0), 0);

      // 3. Nombre d'abonnés payants (creator_subscriptions actifs de followers)
      // On compte les abonnements créateur actifs sur la plateforme comme métrique
      const { count: subscriberCount } = await supabase
        .from('creator_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'active');

      // 4. Ancienneté du compte
      const { data: profile } = await supabase
        .from('profiles')
        .select('created_at')
        .eq('user_id', user.id)
        .single();

      const createdAt = profile?.created_at ? new Date(profile.created_at) : new Date();
      const accountAgeDays = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

      return {
        followers: followerCount ?? 0,
        liveViews30d,
        subscribers: subscriberCount ?? 0,
        accountAgeDays,
      };
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });

  const followers = data?.followers ?? 0;
  const liveViews30d = data?.liveViews30d ?? 0;
  const subscribers = data?.subscribers ?? 0;
  const accountAgeDays = data?.accountAgeDays ?? 0;

  const meetFollowers = followers >= CREATOR_THRESHOLDS.followers;
  const meetLiveViews = liveViews30d >= CREATOR_THRESHOLDS.liveViews30d;
  const meetSubscribers = subscribers >= CREATOR_THRESHOLDS.subscribers;
  const meetAccountAge = accountAgeDays >= CREATOR_THRESHOLDS.minAgeDays;

  return {
    followers,
    liveViews30d,
    subscribers,
    accountAgeDays,
    meetFollowers,
    meetLiveViews,
    meetSubscribers,
    meetAccountAge,
    eligible: meetFollowers && meetLiveViews && meetSubscribers && meetAccountAge,
    loading: isLoading,
  };
}
