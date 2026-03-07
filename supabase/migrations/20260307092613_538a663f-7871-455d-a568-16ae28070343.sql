
-- Add age targeting and moderation fields to ad_campaigns
ALTER TABLE public.ad_campaigns 
  ADD COLUMN IF NOT EXISTS target_age_min integer DEFAULT 18,
  ADD COLUMN IF NOT EXISTS target_age_max integer DEFAULT 65,
  ADD COLUMN IF NOT EXISTS target_gender text DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS target_interests text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS moderation_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS moderation_reason text;

-- Add daily stats tracking table
CREATE TABLE public.ad_daily_stats (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,
  stat_date date NOT NULL DEFAULT CURRENT_DATE,
  impressions integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  reach integer NOT NULL DEFAULT 0,
  spent numeric NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, stat_date)
);

ALTER TABLE public.ad_daily_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Advertisers can view their stats" ON public.ad_daily_stats
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.ad_campaigns 
    WHERE ad_campaigns.id = ad_daily_stats.campaign_id 
    AND ad_campaigns.advertiser_id = auth.uid()
  ));

CREATE POLICY "System can manage stats" ON public.ad_daily_stats
  FOR ALL TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.ad_campaigns 
    WHERE ad_campaigns.id = ad_daily_stats.campaign_id 
    AND ad_campaigns.advertiser_id = auth.uid()
  ));
