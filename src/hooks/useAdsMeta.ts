/**
 * Meta-style ads hierarchy hooks: Campaign → Ad Set → Ad.
 * - `ad_campaigns` (existing) = Campaign level: objective + status
 * - `ad_sets` = audience, budget, schedule, placements
 * - `ads` = creative + KPIs
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/lib/auth';
import { toast } from 'sonner';

export const OBJECTIVES = [
  { value: 'awareness', label: 'Notoriété', desc: 'Faire connaître ta marque', icon: '📣' },
  { value: 'traffic', label: 'Trafic', desc: 'Envoyer vers un site ou une page', icon: '🚀' },
  { value: 'engagement', label: 'Engagement', desc: 'Likes, commentaires, partages', icon: '💬' },
  { value: 'leads', label: 'Prospects', desc: 'Récolter des coordonnées', icon: '🎯' },
  { value: 'sales', label: 'Ventes', desc: 'Conversions et achats', icon: '🛍️' },
  { value: 'app_promotion', label: 'Promotion app', desc: 'Installations d\'application', icon: '📱' },
] as const;

export const PLACEMENTS = [
  { value: 'feed', label: 'Fil d\'actualité' },
  { value: 'stories', label: 'Stories' },
  { value: 'live', label: 'Lives' },
  { value: 'marketplace', label: 'Marketplace' },
  { value: 'sidebar', label: 'Colonne latérale' },
] as const;

export interface AdSet {
  id: string;
  campaign_id: string;
  advertiser_id: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'ended';
  daily_budget: number | null;
  lifetime_budget: number | null;
  starts_at: string;
  ends_at: string;
  target_age_min: number;
  target_age_max: number;
  target_gender: 'all' | 'male' | 'female';
  target_interests: string[];
  target_location: any;
  placements: string[];
  optimization_goal: 'reach' | 'impressions' | 'clicks' | 'conversions' | 'engagement';
  created_at: string;
  updated_at: string;
}

export interface Ad {
  id: string;
  ad_set_id: string;
  advertiser_id: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'ended' | 'rejected';
  headline: string;
  primary_text: string;
  description: string | null;
  image_url: string | null;
  video_url: string | null;
  cta_text: string;
  cta_url: string | null;
  moderation_status: 'pending' | 'approved' | 'rejected';
  moderation_reason: string | null;
  impressions: number;
  clicks: number;
  reach: number;
  spent: number;
  created_at: string;
  updated_at: string;
}

// ─── Ad Sets ───

export function useAdSets(campaignId?: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['ad-sets', user?.id, campaignId],
    queryFn: async () => {
      let q = supabase
        .from('ad_sets' as any)
        .select('*')
        .eq('advertiser_id', user!.id)
        .order('created_at', { ascending: false });
      if (campaignId) q = q.eq('campaign_id', campaignId);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as unknown as AdSet[];
    },
    enabled: !!user,
  });
}

export function useCreateAdSet() {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Partial<AdSet> & { campaign_id: string }) => {
      const { data, error } = await supabase
        .from('ad_sets' as any)
        .insert({ ...payload, advertiser_id: user!.id })
        .select()
        .single();
      if (error) throw error;
      return data as unknown as AdSet;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ad-sets'] });
      toast.success('Ensemble de publicités créé');
    },
    onError: (e: any) => toast.error(e.message ?? 'Erreur'),
  });
}

export function useUpdateAdSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<AdSet> }) => {
      const { data, error } = await supabase
        .from('ad_sets' as any)
        .update(patch)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data as unknown as AdSet;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ad-sets'] }),
  });
}

// ─── Ads ───

export function useAds(adSetId?: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['ads', user?.id, adSetId],
    queryFn: async () => {
      let q = supabase
        .from('ads' as any)
        .select('*')
        .eq('advertiser_id', user!.id)
        .order('created_at', { ascending: false });
      if (adSetId) q = q.eq('ad_set_id', adSetId);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as unknown as Ad[];
    },
    enabled: !!user,
  });
}

export function useCreateAd() {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Partial<Ad> & { ad_set_id: string; headline: string; primary_text: string }) => {
      const { data, error } = await supabase
        .from('ads' as any)
        .insert({ ...payload, advertiser_id: user!.id })
        .select()
        .single();
      if (error) throw error;
      return data as unknown as Ad;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ads'] });
      toast.success('Publicité créée');
    },
    onError: (e: any) => toast.error(e.message ?? 'Erreur'),
  });
}

export function useUpdateAd() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Ad> }) => {
      const { data, error } = await supabase
        .from('ads' as any)
        .update(patch)
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data as unknown as Ad;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ads'] }),
  });
}
