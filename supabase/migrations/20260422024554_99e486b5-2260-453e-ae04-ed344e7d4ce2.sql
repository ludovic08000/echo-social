-- ML Feed: Auto-learning hybrid (collaborative + content-based + temporal)

-- 1. User preference profiles (collaborative + temporal patterns)
CREATE TABLE IF NOT EXISTS public.ml_user_profiles (
  user_id UUID PRIMARY KEY,
  topic_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
  hashtag_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
  author_affinity JSONB NOT NULL DEFAULT '{}'::jsonb,
  hourly_activity JSONB NOT NULL DEFAULT '{}'::jsonb,
  daily_activity JSONB NOT NULL DEFAULT '{}'::jsonb,
  avg_session_dwell_ms INTEGER NOT NULL DEFAULT 0,
  total_interactions INTEGER NOT NULL DEFAULT 0,
  last_trained_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ml_user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own ML profile"
ON public.ml_user_profiles FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all ML profiles"
ON public.ml_user_profiles FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service can manage ML profiles"
ON public.ml_user_profiles FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 2. Post content features (extracted by AI)
CREATE TABLE IF NOT EXISTS public.ml_post_features (
  post_id UUID PRIMARY KEY,
  topics TEXT[] NOT NULL DEFAULT '{}',
  hashtags TEXT[] NOT NULL DEFAULT '{}',
  sentiment NUMERIC(4,3) NOT NULL DEFAULT 0,
  quality_score NUMERIC(4,3) NOT NULL DEFAULT 0.5,
  language TEXT,
  has_media BOOLEAN NOT NULL DEFAULT false,
  engagement_velocity NUMERIC NOT NULL DEFAULT 0,
  ctr NUMERIC(5,4) NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  positive_count INTEGER NOT NULL DEFAULT 0,
  negative_count INTEGER NOT NULL DEFAULT 0,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ml_post_features ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read post features"
ON public.ml_post_features FOR SELECT
USING (true);

CREATE POLICY "Admins can manage post features"
ON public.ml_post_features FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 3. ML interactions (implicit + explicit + temporal signals)
CREATE TABLE IF NOT EXISTS public.ml_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  post_id UUID NOT NULL,
  signal_type TEXT NOT NULL,
  weight NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  dwell_ms INTEGER,
  scroll_depth NUMERIC(3,2),
  hour_of_day SMALLINT NOT NULL DEFAULT EXTRACT(HOUR FROM now()),
  day_of_week SMALLINT NOT NULL DEFAULT EXTRACT(DOW FROM now()),
  is_weekend BOOLEAN NOT NULL DEFAULT (EXTRACT(DOW FROM now()) IN (0, 6)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ml_interactions_user ON public.ml_interactions(user_id, created_at DESC);
CREATE INDEX idx_ml_interactions_post ON public.ml_interactions(post_id, created_at DESC);
CREATE INDEX idx_ml_interactions_signal ON public.ml_interactions(signal_type, created_at DESC);

ALTER TABLE public.ml_interactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own interactions"
ON public.ml_interactions FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view own interactions"
ON public.ml_interactions FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all interactions"
ON public.ml_interactions FOR SELECT
USING (has_role(auth.uid(), 'admin'::app_role));

-- 4. Model training runs (history + status)
CREATE TABLE IF NOT EXISTS public.ml_model_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type TEXT NOT NULL DEFAULT 'hourly',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  users_processed INTEGER DEFAULT 0,
  posts_processed INTEGER DEFAULT 0,
  interactions_analyzed INTEGER DEFAULT 0,
  error_message TEXT,
  metrics JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ml_model_runs_started ON public.ml_model_runs(started_at DESC);

ALTER TABLE public.ml_model_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage model runs"
ON public.ml_model_runs FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 5. Model config (weights for hybrid scoring, tunable from admin)
CREATE TABLE IF NOT EXISTS public.ml_model_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ml_model_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read config"
ON public.ml_model_config FOR SELECT
USING (true);

CREATE POLICY "Admins manage config"
ON public.ml_model_config FOR ALL
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Default weights
INSERT INTO public.ml_model_config (key, value, description) VALUES
('hybrid_weights', '{"collaborative": 0.4, "content": 0.4, "temporal": 0.1, "quality": 0.1}'::jsonb, 'Hybrid scoring weights (must sum to 1)'),
('signal_weights', '{"view": 0.5, "dwell_long": 1.5, "like": 2.0, "comment": 3.0, "share": 4.0, "hide": -3.0, "report": -5.0, "skip_fast": -1.0}'::jsonb, 'Signal weights for interactions'),
('decay_half_life_days', '7'::jsonb, 'Half-life in days for interaction decay'),
('min_interactions_for_personalization', '5'::jsonb, 'Min interactions before personalizing')
ON CONFLICT (key) DO NOTHING;

-- 6. Updated-at triggers
CREATE TRIGGER update_ml_user_profiles_updated_at
BEFORE UPDATE ON public.ml_user_profiles
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_ml_post_features_updated_at
BEFORE UPDATE ON public.ml_post_features
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 7. Helper: get personalized score for a post
CREATE OR REPLACE FUNCTION public.ml_score_post(p_user_id UUID, p_post_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile ml_user_profiles%ROWTYPE;
  v_features ml_post_features%ROWTYPE;
  v_weights JSONB;
  v_collab NUMERIC := 0;
  v_content NUMERIC := 0;
  v_temporal NUMERIC := 0;
  v_quality NUMERIC := 0;
  v_score NUMERIC := 0;
  v_topic TEXT;
  v_hashtag TEXT;
  v_hour TEXT;
  v_post_author UUID;
BEGIN
  SELECT * INTO v_profile FROM ml_user_profiles WHERE user_id = p_user_id;
  SELECT * INTO v_features FROM ml_post_features WHERE post_id = p_post_id;
  SELECT value INTO v_weights FROM ml_model_config WHERE key = 'hybrid_weights';

  IF v_features.post_id IS NULL THEN
    RETURN 0.5;
  END IF;

  -- Content score: sum topic + hashtag affinities
  IF v_profile.user_id IS NOT NULL THEN
    FOREACH v_topic IN ARRAY v_features.topics LOOP
      v_content := v_content + COALESCE((v_profile.topic_weights->>v_topic)::NUMERIC, 0);
    END LOOP;
    FOREACH v_hashtag IN ARRAY v_features.hashtags LOOP
      v_content := v_content + COALESCE((v_profile.hashtag_weights->>v_hashtag)::NUMERIC, 0) * 0.5;
    END LOOP;
    v_content := LEAST(1.0, GREATEST(0.0, v_content / 5.0));

    -- Collaborative: author affinity
    SELECT user_id INTO v_post_author FROM posts WHERE id = p_post_id;
    IF v_post_author IS NOT NULL THEN
      v_collab := COALESCE((v_profile.author_affinity->>v_post_author::text)::NUMERIC, 0);
      v_collab := LEAST(1.0, GREATEST(0.0, v_collab));
    END IF;

    -- Temporal: matches user's active hour
    v_hour := EXTRACT(HOUR FROM now())::text;
    v_temporal := COALESCE((v_profile.hourly_activity->>v_hour)::NUMERIC, 0.5);
    v_temporal := LEAST(1.0, GREATEST(0.0, v_temporal));
  ELSE
    v_content := 0.5;
    v_collab := 0.5;
    v_temporal := 0.5;
  END IF;

  -- Quality: blend of post quality + ctr
  v_quality := (COALESCE(v_features.quality_score, 0.5) + LEAST(1.0, COALESCE(v_features.ctr, 0) * 10)) / 2.0;

  v_score := (v_collab * COALESCE((v_weights->>'collaborative')::NUMERIC, 0.4))
           + (v_content * COALESCE((v_weights->>'content')::NUMERIC, 0.4))
           + (v_temporal * COALESCE((v_weights->>'temporal')::NUMERIC, 0.1))
           + (v_quality * COALESCE((v_weights->>'quality')::NUMERIC, 0.1));

  RETURN LEAST(1.0, GREATEST(0.0, v_score));
END;
$$;