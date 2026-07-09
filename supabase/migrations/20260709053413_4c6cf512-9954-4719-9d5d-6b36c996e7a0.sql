
-- ── 1. Add campaign objective to ad_campaigns ──
ALTER TABLE public.ad_campaigns
  ADD COLUMN IF NOT EXISTS objective text NOT NULL DEFAULT 'traffic'
    CHECK (objective IN ('awareness','traffic','engagement','leads','sales','app_promotion'));

-- ── 2. ad_sets: audience + budget + schedule + placements ──
CREATE TABLE IF NOT EXISTS public.ad_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.ad_campaigns(id) ON DELETE CASCADE,
  advertiser_id uuid NOT NULL,
  name text NOT NULL DEFAULT 'Ensemble par défaut',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','paused','ended')),
  -- budget & schedule
  daily_budget numeric,
  lifetime_budget numeric,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  -- targeting
  target_age_min integer DEFAULT 18,
  target_age_max integer DEFAULT 65,
  target_gender text DEFAULT 'all' CHECK (target_gender IN ('all','male','female')),
  target_interests text[] DEFAULT ARRAY[]::text[],
  target_location jsonb,
  -- placements
  placements text[] NOT NULL DEFAULT ARRAY['feed','stories']::text[],
  optimization_goal text NOT NULL DEFAULT 'reach'
    CHECK (optimization_goal IN ('reach','impressions','clicks','conversions','engagement')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ad_sets TO authenticated;
GRANT ALL ON public.ad_sets TO service_role;

ALTER TABLE public.ad_sets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Advertiser manages own ad sets" ON public.ad_sets
  FOR ALL TO authenticated
  USING (advertiser_id = auth.uid())
  WITH CHECK (advertiser_id = auth.uid());

CREATE INDEX IF NOT EXISTS ad_sets_campaign_idx ON public.ad_sets(campaign_id);
CREATE INDEX IF NOT EXISTS ad_sets_advertiser_idx ON public.ad_sets(advertiser_id);

-- ── 3. ads: creative + KPIs ──
CREATE TABLE IF NOT EXISTS public.ads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_set_id uuid NOT NULL REFERENCES public.ad_sets(id) ON DELETE CASCADE,
  advertiser_id uuid NOT NULL,
  name text NOT NULL DEFAULT 'Publicité',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','paused','ended','rejected')),
  -- creative
  headline text NOT NULL,
  primary_text text NOT NULL,
  description text,
  image_url text,
  video_url text,
  cta_text text DEFAULT 'En savoir plus',
  cta_url text,
  -- moderation
  moderation_status text NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending','approved','rejected')),
  moderation_reason text,
  -- KPIs
  impressions integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  reach integer NOT NULL DEFAULT 0,
  spent numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ads TO authenticated;
GRANT ALL ON public.ads TO service_role;

ALTER TABLE public.ads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Advertiser manages own ads" ON public.ads
  FOR ALL TO authenticated
  USING (advertiser_id = auth.uid())
  WITH CHECK (advertiser_id = auth.uid());

-- Public read for approved/active ads (feed rendering)
CREATE POLICY "Approved active ads publicly visible" ON public.ads
  FOR SELECT TO authenticated, anon
  USING (status = 'active' AND moderation_status = 'approved');

CREATE INDEX IF NOT EXISTS ads_ad_set_idx ON public.ads(ad_set_id);
CREATE INDEX IF NOT EXISTS ads_advertiser_idx ON public.ads(advertiser_id);
CREATE INDEX IF NOT EXISTS ads_public_idx ON public.ads(status, moderation_status);

-- ── 4. updated_at triggers ──
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS ad_sets_updated_at ON public.ad_sets;
CREATE TRIGGER ad_sets_updated_at BEFORE UPDATE ON public.ad_sets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS ads_updated_at ON public.ads;
CREATE TRIGGER ads_updated_at BEFORE UPDATE ON public.ads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 5. Backfill existing campaigns → default ad_set + default ad ──
DO $$
DECLARE
  c RECORD;
  new_set_id uuid;
BEGIN
  FOR c IN SELECT * FROM public.ad_campaigns LOOP
    -- Skip if this campaign already has ad_sets (idempotent)
    IF EXISTS (SELECT 1 FROM public.ad_sets WHERE campaign_id = c.id) THEN CONTINUE; END IF;

    INSERT INTO public.ad_sets (
      campaign_id, advertiser_id, name, status,
      daily_budget, lifetime_budget, starts_at, ends_at,
      target_age_min, target_age_max, target_gender, target_interests, target_location,
      placements, optimization_goal
    ) VALUES (
      c.id, c.advertiser_id, 'Ensemble principal',
      CASE WHEN c.status IN ('active','paused','ended','draft') THEN c.status ELSE 'active' END,
      c.daily_budget, c.budget, c.starts_at, c.ends_at,
      COALESCE(c.target_age_min, 18), COALESCE(c.target_age_max, 65),
      COALESCE(c.target_gender, 'all'), COALESCE(c.target_interests, ARRAY[]::text[]),
      c.target_location, ARRAY['feed','stories']::text[], 'reach'
    ) RETURNING id INTO new_set_id;

    INSERT INTO public.ads (
      ad_set_id, advertiser_id, name, status,
      headline, primary_text, image_url, video_url, cta_text, cta_url,
      moderation_status, moderation_reason,
      impressions, clicks, reach, spent
    ) VALUES (
      new_set_id, c.advertiser_id, c.title,
      CASE WHEN c.status IN ('active','paused','ended','draft') THEN c.status ELSE 'active' END,
      c.title, c.body, c.image_url, c.video_url,
      COALESCE(c.cta_text, 'En savoir plus'), c.cta_url,
      COALESCE(c.moderation_status, 'pending'), c.moderation_reason,
      COALESCE(c.impressions, 0), COALESCE(c.clicks, 0),
      COALESCE(c.reach, 0), COALESCE(c.spent, 0)
    );
  END LOOP;
END $$;
