
-- ═══════════════════════════════════════════════
-- 1. TRUST SCORES (public reputation system)
-- ═══════════════════════════════════════════════
CREATE TABLE public.trust_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  -- Composite score 0-100
  trust_score integer NOT NULL DEFAULT 50,
  -- Sub-scores
  transaction_score integer NOT NULL DEFAULT 50,
  social_score integer NOT NULL DEFAULT 50,
  account_age_score integer NOT NULL DEFAULT 0,
  verification_score integer NOT NULL DEFAULT 0,
  -- Counters
  successful_sales integer NOT NULL DEFAULT 0,
  successful_purchases integer NOT NULL DEFAULT 0,
  disputes_opened integer NOT NULL DEFAULT 0,
  disputes_lost integer NOT NULL DEFAULT 0,
  reports_received integer NOT NULL DEFAULT 0,
  reports_confirmed integer NOT NULL DEFAULT 0,
  -- Flags
  is_verified_identity boolean NOT NULL DEFAULT false,
  is_flagged boolean NOT NULL DEFAULT false,
  flag_reason text,
  -- Timestamps
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.trust_scores ENABLE ROW LEVEL SECURITY;

-- Everyone can read trust scores (public reputation)
CREATE POLICY "Trust scores are publicly readable"
  ON public.trust_scores FOR SELECT
  USING (true);

-- Only system/edge functions insert/update via service role
CREATE POLICY "System can manage trust scores"
  ON public.trust_scores FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() = user_id);

-- ═══════════════════════════════════════════════
-- 2. ABUSE REPORTS
-- ═══════════════════════════════════════════════
CREATE TABLE public.abuse_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL,
  reported_user_id uuid NOT NULL,
  report_type text NOT NULL DEFAULT 'spam',
  -- spam, harassment, fake_account, multi_account, bot, scam, other
  description text,
  evidence_urls text[] DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  -- pending, investigating, confirmed, dismissed
  resolution text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.abuse_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can create abuse reports"
  ON public.abuse_reports FOR INSERT
  WITH CHECK (auth.uid() = reporter_id);

CREATE POLICY "Users can view their own reports"
  ON public.abuse_reports FOR SELECT
  USING (auth.uid() = reporter_id);

-- ═══════════════════════════════════════════════
-- 3. DEVICE FINGERPRINTS (multi-account detection)
-- ═══════════════════════════════════════════════
CREATE TABLE public.device_fingerprints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  fingerprint_hash text NOT NULL,
  ip_address text,
  user_agent text,
  screen_resolution text,
  timezone text,
  language text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.device_fingerprints ENABLE ROW LEVEL SECURITY;

-- Users can insert their own fingerprints
CREATE POLICY "Users can insert fingerprints"
  ON public.device_fingerprints FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can view their own fingerprints
CREATE POLICY "Users can view own fingerprints"
  ON public.device_fingerprints FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own fingerprints"
  ON public.device_fingerprints FOR UPDATE
  USING (auth.uid() = user_id);

-- ═══════════════════════════════════════════════
-- 4. RATE LIMITS (anti-bot)
-- ═══════════════════════════════════════════════
CREATE TABLE public.rate_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action_type text NOT NULL,
  -- post, comment, like, message, report, purchase
  action_count integer NOT NULL DEFAULT 1,
  window_start timestamptz NOT NULL DEFAULT now(),
  window_end timestamptz NOT NULL DEFAULT (now() + interval '1 hour'),
  is_blocked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own rate limits"
  ON public.rate_limits FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "System can manage rate limits"
  ON public.rate_limits FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() = user_id);

-- ═══════════════════════════════════════════════
-- 5. FEED SCORES CACHE (server-side feed scoring)
-- ═══════════════════════════════════════════════
CREATE TABLE public.feed_score_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  score numeric NOT NULL DEFAULT 0,
  scoring_factors jsonb DEFAULT '{}',
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, post_id)
);

ALTER TABLE public.feed_score_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own feed scores"
  ON public.feed_score_cache FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "System can manage feed scores"
  ON public.feed_score_cache FOR ALL
  USING (auth.uid() IS NOT NULL)
  WITH CHECK (auth.uid() = user_id);

-- ═══════════════════════════════════════════════
-- 6. INDEXES
-- ═══════════════════════════════════════════════
CREATE INDEX idx_trust_scores_user ON public.trust_scores(user_id);
CREATE INDEX idx_abuse_reports_reported ON public.abuse_reports(reported_user_id);
CREATE INDEX idx_device_fingerprints_hash ON public.device_fingerprints(fingerprint_hash);
CREATE INDEX idx_device_fingerprints_user ON public.device_fingerprints(user_id);
CREATE INDEX idx_rate_limits_user_action ON public.rate_limits(user_id, action_type, window_start);
CREATE INDEX idx_feed_score_cache_user ON public.feed_score_cache(user_id, score DESC);

-- ═══════════════════════════════════════════════
-- 7. TRIGGER: auto-create trust score on profile creation
-- ═══════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.handle_new_trust_score()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO public.trust_scores (user_id)
  VALUES (NEW.user_id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_profile_created_trust_score
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_trust_score();
