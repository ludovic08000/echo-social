-- ============================================================
-- TWO-TOWER NEURAL NETWORK + PARETO MULTI-OBJECTIVE RANKING
-- ============================================================

-- 1) USER EMBEDDINGS TABLE (User Tower output)
CREATE TABLE IF NOT EXISTS public.ml_user_embeddings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  embedding vector(256),
  training_samples INTEGER NOT NULL DEFAULT 0,
  last_trained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ml_user_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own embedding"
  ON public.ml_user_embeddings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all embeddings"
  ON public.ml_user_embeddings FOR SELECT
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Service role manages embeddings"
  ON public.ml_user_embeddings FOR ALL
  USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_ml_user_emb_vector
  ON public.ml_user_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 2) POST EMBEDDINGS TABLE (Item Tower output)
CREATE TABLE IF NOT EXISTS public.ml_post_embeddings (
  post_id UUID PRIMARY KEY REFERENCES public.posts(id) ON DELETE CASCADE,
  embedding vector(256),
  training_samples INTEGER NOT NULL DEFAULT 0,
  last_trained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ml_post_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view post embeddings"
  ON public.ml_post_embeddings FOR SELECT
  USING (true);

CREATE POLICY "Service role manages post embeddings"
  ON public.ml_post_embeddings FOR ALL
  USING (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS idx_ml_post_emb_vector
  ON public.ml_post_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 3) MULTI-HEAD SCORES on ml_post_features
ALTER TABLE public.ml_post_features
  ADD COLUMN IF NOT EXISTS engagement_score NUMERIC NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS wellbeing_score NUMERIC NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS revenue_score NUMERIC NOT NULL DEFAULT 0.0;

-- 4) TWO-TOWER SCORING FUNCTION (cosine similarity)
CREATE OR REPLACE FUNCTION public.ml_score_post_v4(p_user_id UUID, p_post_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_emb vector(256);
  v_post_emb vector(256);
  v_similarity NUMERIC;
  v_fallback NUMERIC;
BEGIN
  SELECT embedding INTO v_user_emb FROM ml_user_embeddings WHERE user_id = p_user_id;
  SELECT embedding INTO v_post_emb FROM ml_post_embeddings WHERE post_id = p_post_id;

  -- Cold start fallback to v3 hybrid score
  IF v_user_emb IS NULL OR v_post_emb IS NULL THEN
    v_fallback := ml_score_post(p_user_id, p_post_id);
    RETURN COALESCE(v_fallback, 0.5);
  END IF;

  -- Cosine similarity in [-1, 1] -> normalize to [0, 1]
  v_similarity := 1 - (v_user_emb <=> v_post_emb);
  RETURN GREATEST(0.0, LEAST(1.0, (v_similarity + 1.0) / 2.0));
END;
$$;

-- 5) COMPUTE MULTI-HEAD SCORES from existing signals
CREATE OR REPLACE FUNCTION public.ml_compute_post_scores(p_post_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post posts%ROWTYPE;
  v_engagement NUMERIC := 0.5;
  v_wellbeing NUMERIC := 0.5;
  v_revenue NUMERIC := 0.0;
  v_is_creator BOOLEAN := false;
  v_recent_tips NUMERIC := 0;
  v_negative_signals INTEGER := 0;
  v_positive_signals INTEGER := 0;
  v_total_signals INTEGER := 0;
BEGIN
  SELECT * INTO v_post FROM posts WHERE id = p_post_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- ENGAGEMENT: blend likes/comments velocity + ctr
  SELECT 
    LEAST(1.0, (
      LN(1 + COALESCE(v_post.likes_count, 0)) * 0.4 +
      LN(1 + COALESCE(v_post.comments_count, 0)) * 0.6
    ) / 5.0)
  INTO v_engagement;

  -- WELLBEING: penalize posts with negative reactions (hide/report/skip_fast)
  SELECT 
    COUNT(*) FILTER (WHERE signal_type IN ('hide', 'report', 'skip_fast')),
    COUNT(*) FILTER (WHERE signal_type IN ('like', 'comment', 'share', 'dwell_long')),
    COUNT(*)
  INTO v_negative_signals, v_positive_signals, v_total_signals
  FROM ml_interactions
  WHERE post_id = p_post_id
    AND created_at > now() - interval '7 days';

  IF v_total_signals > 5 THEN
    v_wellbeing := GREATEST(0.0, LEAST(1.0, 
      0.5 + (v_positive_signals - v_negative_signals * 2.0)::NUMERIC / GREATEST(v_total_signals, 1) * 0.5
    ));
  END IF;

  -- REVENUE: creator premium + recent tips
  SELECT EXISTS (
    SELECT 1 FROM creator_subscriptions cs
    WHERE cs.user_id = v_post.user_id
      AND cs.status = 'active'
      AND cs.current_period_end > now()
  ) INTO v_is_creator;

  -- Recent tips received by author (last 30 days)
  BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO v_recent_tips
    FROM tips
    WHERE recipient_id = v_post.user_id
      AND created_at > now() - interval '30 days';
  EXCEPTION WHEN undefined_table THEN
    v_recent_tips := 0;
  END;

  v_revenue := LEAST(1.0,
    (CASE WHEN v_is_creator THEN 0.4 ELSE 0.0 END) +
    LEAST(0.6, v_recent_tips / 100.0 * 0.6)
  );

  -- Upsert
  INSERT INTO ml_post_features (post_id, engagement_score, wellbeing_score, revenue_score, last_computed_at)
  VALUES (p_post_id, v_engagement, v_wellbeing, v_revenue, now())
  ON CONFLICT (post_id) DO UPDATE SET
    engagement_score = EXCLUDED.engagement_score,
    wellbeing_score = EXCLUDED.wellbeing_score,
    revenue_score = EXCLUDED.revenue_score,
    last_computed_at = now();
END;
$$;

-- 6) PARETO MULTI-OBJECTIVE RANKING
-- Combines engagement + wellbeing + revenue with a Pareto penalty:
-- a post that sacrifices ANY objective heavily is penalized.
CREATE OR REPLACE FUNCTION public.ml_pareto_score(
  p_user_id UUID,
  p_post_id UUID,
  p_w_engagement NUMERIC DEFAULT 0.55,
  p_w_wellbeing NUMERIC DEFAULT 0.30,
  p_w_revenue NUMERIC DEFAULT 0.15
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_features ml_post_features%ROWTYPE;
  v_two_tower NUMERIC;
  v_engagement NUMERIC;
  v_wellbeing NUMERIC;
  v_revenue NUMERIC;
  v_weighted NUMERIC;
  v_min_obj NUMERIC;
  v_pareto_penalty NUMERIC;
  v_user_wellbeing INTEGER;
BEGIN
  SELECT * INTO v_features FROM ml_post_features WHERE post_id = p_post_id;
  IF NOT FOUND THEN
    RETURN 0.4; -- mild fallback
  END IF;

  -- Use Two-Tower as the engagement signal (best personalization)
  v_two_tower := ml_score_post_v4(p_user_id, p_post_id);
  v_engagement := (v_two_tower * 0.7 + COALESCE(v_features.engagement_score, 0.5) * 0.3);
  v_wellbeing := COALESCE(v_features.wellbeing_score, 0.5);
  v_revenue := COALESCE(v_features.revenue_score, 0.0);

  -- Adaptive: if user has low wellbeing score, boost wellbeing weight
  SELECT score INTO v_user_wellbeing FROM wellbeing_scores WHERE user_id = p_user_id;
  IF v_user_wellbeing IS NOT NULL AND v_user_wellbeing < 50 THEN
    p_w_wellbeing := p_w_wellbeing + 0.15;
    p_w_engagement := p_w_engagement - 0.15;
  END IF;

  -- Weighted sum
  v_weighted := v_engagement * p_w_engagement
              + v_wellbeing * p_w_wellbeing
              + v_revenue * p_w_revenue;

  -- Pareto penalty: if the worst objective is below 0.2, penalize the score.
  -- Revenue is excluded from the floor (most posts have 0 revenue, that's normal).
  v_min_obj := LEAST(v_engagement, v_wellbeing);
  v_pareto_penalty := CASE
    WHEN v_min_obj < 0.2 THEN 0.7  -- strong penalty
    WHEN v_min_obj < 0.35 THEN 0.9
    ELSE 1.0
  END;

  RETURN GREATEST(0.0, LEAST(1.0, v_weighted * v_pareto_penalty));
END;
$$;

-- 7) Trigger: auto-compute scores when a post gets new interactions
CREATE OR REPLACE FUNCTION public.trigger_recompute_post_scores()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Async-friendly: only recompute occasionally (every ~10th signal)
  IF (random() < 0.1) THEN
    PERFORM ml_compute_post_scores(NEW.post_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auto_recompute_post_scores ON public.ml_interactions;
CREATE TRIGGER auto_recompute_post_scores
  AFTER INSERT ON public.ml_interactions
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_recompute_post_scores();