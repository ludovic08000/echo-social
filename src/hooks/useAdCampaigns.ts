import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';
import { type TargetLocation } from '@/lib/geoData';
import { type AdPlacement } from '@/lib/ads/adDelivery';
import { type Json } from '@/integrations/supabase/types';
import { useDiscoveryPreferences } from './useDiscoveryPreferences';
import { useAdLocation } from './useAdLocation';
import { adSessionCacheKey } from '@/lib/ads/sessionCacheKey';

type AdAudience = { description?: string; [key: string]: Json | undefined };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export interface AdCampaign {
  id: string;
  advertiser_id: string;
  objective: string;
  title: string;
  body: string;
  image_url: string | null;
  cta_text: string;
  cta_url: string | null;
  target_audience: Json | null;
  target_age_min: number;
  target_age_max: number;
  target_gender: string;
  target_interests: string[];
  budget: number;
  daily_budget: number | null;
  duration_type: string;
  starts_at: string;
  ends_at: string;
  status: string;
  moderation_status: string;
  moderation_reason: string | null;
  impressions: number;
  clicks: number;
  reach: number;
  spent: number;
  paid_at?: string | null;
  created_at: string;
}

export interface AdDailyStat {
  id: string;
  campaign_id: string;
  stat_date: string;
  impressions: number;
  clicks: number;
  reach: number;
  spent: number;
}

export interface FeedAd {
  id: string;
  headline: string;
  primary_text: string;
  image_url: string | null;
  video_url: string | null;
  cta_text: string;
  cta_url: string | null;
}

const PRICING = {
  '1_day': { label: '1 jour', price: 5, reach: '500-2K' },
  '3_days': { label: '3 jours', price: 12, reach: '1.5K-5K' },
  '1_week': { label: '1 semaine', price: 25, reach: '5K-15K' },
  '2_weeks': { label: '2 semaines', price: 45, reach: '10K-30K' },
  '1_month': { label: '1 mois', price: 80, reach: '25K-80K' },
  '3_months': { label: '3 mois', price: 200, reach: '80K-250K' },
} as const;

export type DurationType = keyof typeof PRICING;

export function getAdPricing() {
  return PRICING;
}

function getEndDate(durationType: DurationType, startDate: Date = new Date()): Date {
  const end = new Date(startDate);
  switch (durationType) {
    case '1_day': end.setDate(end.getDate() + 1); break;
    case '3_days': end.setDate(end.getDate() + 3); break;
    case '1_week': end.setDate(end.getDate() + 7); break;
    case '2_weeks': end.setDate(end.getDate() + 14); break;
    case '1_month': end.setMonth(end.getMonth() + 1); break;
    case '3_months': end.setMonth(end.getMonth() + 3); break;
  }
  return end;
}

export function useAdCampaigns() {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: ['ad-campaigns', loading ? 'loading' : user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ad_campaigns')
        .select('*')
        .eq('advertiser_id', user!.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as AdCampaign[];
    },
    enabled: !loading && !!user,
  });
}

export function useAdDailyStats(campaignId?: string) {
  return useQuery({
    queryKey: ['ad-daily-stats', campaignId],
    queryFn: async () => {
      let query = supabase.from('ad_daily_stats').select('*').order('stat_date', { ascending: true });
      if (campaignId) query = query.eq('campaign_id', campaignId);
      const { data, error } = await query;
      if (error) throw error;
      return data as AdDailyStat[];
    },
    enabled: true,
  });
}

export function useActiveAds(placement: AdPlacement = 'feed') {
  const { user, loading, session } = useAuth();
  const { data: preferences } = useDiscoveryPreferences();
  // Independent bounded query: deriving topics must never delay the social feed.
  const sessionKey = adSessionCacheKey(session?.access_token);
  const location = useAdLocation(user?.id, sessionKey, preferences);
  const audience = useQuery({
    queryKey: ['ad-audience', user?.id, preferences?.updated_at],
    enabled: !loading && !!user && preferences?.ads_activity === true,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('refresh_my_ad_audience' as never);
      if (error) throw error;
      return (data ?? []) as unknown as string[];
    },
    staleTime: 5 * 60_000, retry: false,
  });

  return useQuery({
    queryKey: ['active-ads', placement, loading ? 'loading' : user?.id ?? 'guest', sessionKey, preferences?.updated_at, audience.dataUpdatedAt, location.dataUpdatedAt, location.errorUpdatedAt],
    queryFn: async () => {
      if (!user) return [];

      const { data, error } = await supabase.rpc(
        'get_active_ads_for_placement' as never,
        { p_placement: placement, p_limit: 12 } as never,
      );
      if (error) throw error;
      return (data || []) as unknown as FeedAd[];
    },
    enabled: !loading && !!user,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useCreateAdCampaign() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      title: string;
      body: string;
      objective?: string;
      image_url?: string;
      video_url?: string;
      cta_text?: string;
      cta_url?: string;
      target_audience?: AdAudience;
      target_age_min?: number;
      target_age_max?: number;
      target_gender?: string;
      target_interests?: string[];
      target_location?: TargetLocation;
      duration_type?: DurationType;
      duration_days?: number;
      budget?: number;
    }) => {
      if (!user) throw new Error('Connexion requise');

      // 1. Moderate content
      const { data: modResult } = await supabase.functions.invoke('zeus', {
        body: {
          domain: 'ads',
          action: 'moderate_ad',
          ad_title: input.title,
          ad_body: input.body,
          target_audience: input.target_audience?.description,
        },
      });

      const isApproved = modResult?.approved !== false;
      const moderationReason = modResult?.reasons?.join(', ') || null;

      if (!isApproved) {
        throw new Error(`Publicité refusée : ${moderationReason || 'Contenu non conforme'}`);
      }

      const durationType = input.duration_type ?? '1_week';
      const durationDays = input.duration_days;
      const pricing = PRICING[durationType];
      const campaignBudget = input.budget ?? pricing.price;
      if (!Number.isFinite(campaignBudget) || campaignBudget < 5 || campaignBudget > 100_000) {
        throw new Error('Budget invalide (5 € à 100 000 €)');
      }
      if (durationDays !== undefined && (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 90)) {
        throw new Error('Durée invalide (1 à 90 jours)');
      }

      const startsAt = new Date();
      const endsAt = durationDays === undefined
        ? getEndDate(durationType, startsAt)
        : new Date(startsAt.getTime() + durationDays * 24 * 60 * 60 * 1000);
      const targetLocation: Json = {
        country: input.target_location?.country ?? 'FR',
        region: input.target_location?.region ?? null,
        villes: input.target_location?.villes ?? [],
      };
      
      // 2. Create campaign with status 'pending_payment'
      const { data, error } = await supabase
        .from('ad_campaigns')
        .insert({
          advertiser_id: user!.id,
          title: input.title,
          body: input.body,
          objective: input.objective || 'traffic',
          image_url: input.image_url || null,
          video_url: input.video_url || null,
          cta_text: input.cta_text || 'En savoir plus',
          cta_url: input.cta_url || null,
          target_audience: input.target_audience || {},
          target_age_min: input.target_age_min || 18,
          target_age_max: input.target_age_max || 65,
          target_gender: input.target_gender || 'all',
          target_interests: input.target_interests || [],
          target_location: targetLocation,
          budget: campaignBudget,
          duration_type: durationDays === undefined ? durationType : `custom_${durationDays}_days`,
          starts_at: startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
          status: 'pending_payment',
          moderation_status: 'approved',
          moderation_reason: moderationReason,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ad-campaigns'] }),
    onError: (error: unknown) => toast.error(errorMessage(error, 'Création impossible')),
  });
}

export function useStartAdCheckout() {
  return useMutation({
    mutationFn: async (campaignId: string) => {
      const { data, error } = await supabase.functions.invoke('ad-checkout', {
        body: { campaign_id: campaignId },
      });

      if (error) throw error;
      if (!data?.url) throw new Error('Le paiement publicitaire est indisponible');
      window.location.assign(data.url);
      return data.url as string;
    },
    onError: (error: Error) => toast.error(error.message || 'Erreur de paiement'),
  });
}

export function useDeleteAdCampaign() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (campaignId: string) => {
      if (!user) throw new Error('Connexion requise');

      const { data, error } = await supabase
        .from('ad_campaigns')
        .delete()
        .eq('id', campaignId)
        .eq('advertiser_id', user.id)
        .select('id')
        .maybeSingle();

      if (error) throw error;
      if (!data) throw new Error('Campagne introuvable ou non autorisée');
      return data.id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ad-campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['ad-sets'] });
      queryClient.invalidateQueries({ queryKey: ['ads'] });
      queryClient.invalidateQueries({ queryKey: ['ad-daily-stats'] });
      queryClient.invalidateQueries({ queryKey: ['active-ads'] });
      toast.success('Ancienne campagne supprimée');
    },
    onError: (error: Error) => toast.error(error.message || 'Suppression impossible'),
  });
}

export function useAdAIAssistant() {
  return useMutation({
    mutationFn: async (input: {
      action: 'generate_ad' | 'optimize_ad' | 'recommend_strategy' | 'moderate_ad';
      product_name?: string;
      product_description?: string;
      target_audience?: string;
      duration?: string;
      budget?: number;
      ad_title?: string;
      ad_body?: string;
    }) => {
      const { data, error } = await supabase.functions.invoke('zeus', {
        body: { domain: 'ads', ...input },
      });
      if (error) throw error;
      return data;
    },
    onError: (error: unknown) => toast.error(errorMessage(error, 'Erreur IA')),
  });
}
