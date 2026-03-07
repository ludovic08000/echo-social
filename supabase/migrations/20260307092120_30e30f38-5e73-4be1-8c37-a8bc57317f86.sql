
-- Ad campaigns table
CREATE TABLE public.ad_campaigns (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  advertiser_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  image_url text,
  cta_text text DEFAULT 'En savoir plus',
  cta_url text,
  target_audience jsonb DEFAULT '{}'::jsonb,
  budget numeric NOT NULL DEFAULT 0,
  daily_budget numeric,
  duration_type text NOT NULL DEFAULT '1_day',
  starts_at timestamp with time zone NOT NULL DEFAULT now(),
  ends_at timestamp with time zone NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  impressions integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  reach integer NOT NULL DEFAULT 0,
  spent numeric NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Ad interactions tracking
CREATE TABLE public.ad_interactions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  interaction_type text NOT NULL DEFAULT 'impression',
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.ad_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ad_interactions ENABLE ROW LEVEL SECURITY;

-- Ad campaigns policies
CREATE POLICY "Advertisers can manage their campaigns" ON public.ad_campaigns
  FOR ALL TO authenticated
  USING (auth.uid() = advertiser_id)
  WITH CHECK (auth.uid() = advertiser_id);

CREATE POLICY "Active ads are viewable by everyone" ON public.ad_campaigns
  FOR SELECT TO authenticated
  USING (status = 'active' AND starts_at <= now() AND ends_at > now());

-- Ad interactions policies
CREATE POLICY "Users can create interactions" ON public.ad_interactions
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Advertisers can view their ad interactions" ON public.ad_interactions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.ad_campaigns 
    WHERE ad_campaigns.id = ad_interactions.campaign_id 
    AND ad_campaigns.advertiser_id = auth.uid()
  ));

-- Enable realtime for campaigns
ALTER PUBLICATION supabase_realtime ADD TABLE public.ad_campaigns;
