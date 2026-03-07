
-- Fix overly permissive policy on ad_daily_stats
DROP POLICY IF EXISTS "System can manage stats" ON public.ad_daily_stats;

CREATE POLICY "Advertisers can insert stats" ON public.ad_daily_stats
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.ad_campaigns 
    WHERE ad_campaigns.id = ad_daily_stats.campaign_id 
    AND ad_campaigns.advertiser_id = auth.uid()
  ));

CREATE POLICY "Advertisers can update stats" ON public.ad_daily_stats
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.ad_campaigns 
    WHERE ad_campaigns.id = ad_daily_stats.campaign_id 
    AND ad_campaigns.advertiser_id = auth.uid()
  ));
