import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

export interface AdCampaign {
  id: string;
  advertiser_id: string;
  title: string;
  body: string;
  image_url: string | null;
  cta_text: string;
  cta_url: string | null;
  target_audience: any;
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
  const { user } = useAuth();
  return useQuery({
    queryKey: ['ad-campaigns', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ad_campaigns')
        .select('*')
        .eq('advertiser_id', user!.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as AdCampaign[];
    },
    enabled: !!user,
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

export function useActiveAds() {
  return useQuery({
    queryKey: ['active-ads'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ad_campaigns')
        .select('*')
        .eq('status', 'active')
        .eq('moderation_status', 'approved')
        .lte('starts_at', new Date().toISOString())
        .gt('ends_at', new Date().toISOString())
        .order('budget', { ascending: false })
        .limit(10);
      if (error) throw error;
      return data as AdCampaign[];
    },
  });
}

export function useCreateAdCampaign() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      title: string;
      body: string;
      image_url?: string;
      cta_text?: string;
      cta_url?: string;
      target_audience?: any;
      target_age_min?: number;
      target_age_max?: number;
      target_gender?: string;
      target_interests?: string[];
      duration_type: DurationType;
    }) => {
      // First moderate
      const { data: modResult } = await supabase.functions.invoke('ad-assistant', {
        body: {
          action: 'moderate_ad',
          ad_title: input.title,
          ad_body: input.body,
          target_audience: input.target_audience?.description,
        },
      });

      const isApproved = modResult?.approved !== false;
      const moderationStatus = isApproved ? 'approved' : 'rejected';
      const moderationReason = modResult?.reasons?.join(', ') || null;

      if (!isApproved) {
        throw new Error(`Publicité refusée : ${moderationReason || 'Contenu non conforme'}`);
      }

      const pricing = PRICING[input.duration_type];
      const endsAt = getEndDate(input.duration_type);
      
      const { data, error } = await supabase
        .from('ad_campaigns')
        .insert({
          advertiser_id: user!.id,
          title: input.title,
          body: input.body,
          image_url: input.image_url || null,
          cta_text: input.cta_text || 'En savoir plus',
          cta_url: input.cta_url || null,
          target_audience: input.target_audience || {},
          target_age_min: input.target_age_min || 18,
          target_age_max: input.target_age_max || 65,
          target_gender: input.target_gender || 'all',
          target_interests: input.target_interests || [],
          budget: pricing.price,
          duration_type: input.duration_type,
          ends_at: endsAt.toISOString(),
          status: 'active',
          moderation_status: moderationStatus,
          moderation_reason: moderationReason,
        } as any)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ad-campaigns'] });
      queryClient.invalidateQueries({ queryKey: ['active-ads'] });
      toast.success('Campagne publicitaire approuvée et lancée ! ✅');
    },
    onError: (e: any) => toast.error(e.message),
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
      const { data, error } = await supabase.functions.invoke('ad-assistant', {
        body: input,
      });
      if (error) throw error;
      return data;
    },
    onError: (e: any) => toast.error(e.message || 'Erreur IA'),
  });
}
