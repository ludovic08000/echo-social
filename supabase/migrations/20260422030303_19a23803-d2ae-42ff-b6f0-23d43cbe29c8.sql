-- 1. Watch-time tracking columns
ALTER TABLE public.ml_post_features
  ADD COLUMN IF NOT EXISTS avg_watch_time_ms numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watch_sample_count integer DEFAULT 0;

ALTER TABLE public.ml_user_profiles
  ADD COLUMN IF NOT EXISTS avg_dwell_ms numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS preferred_content_length text DEFAULT 'medium';

-- 2. Score v3: v2 + watch-time predictor bonus
CREATE OR REPLACE FUNCTION public.ml_score_post_v3(p_user_id uuid, p_post_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_base_score NUMERIC;
  v_avg_watch NUMERIC;
  v_user_avg NUMERIC;
  v_watch_bonus NUMERIC := 0;
  v_predicted_engagement NUMERIC := 0.5;
BEGIN
  -- Base = semantic + classic blend (v2)
  v_base_score := public.ml_score_post_v2(p_user_id, p_post_id);

  -- Get post's average watch time and user's average dwell
  SELECT avg_watch_time_ms INTO v_avg_watch
  FROM ml_post_features WHERE post_id = p_post_id;

  SELECT avg_dwell_ms INTO v_user_avg
  FROM ml_user_profiles WHERE user_id = p_user_id;

  -- Predict: if post avg_watch is above user's typical dwell, it's "sticky"
  IF v_avg_watch IS NOT NULL AND v_avg_watch > 0 AND v_user_avg IS NOT NULL AND v_user_avg > 0 THEN
    v_predicted_engagement := LEAST(1.0, v_avg_watch / GREATEST(v_user_avg, 1000));
    v_watch_bonus := (v_predicted_engagement - 0.5) * 0.2; -- ±0.1 max bonus
  END IF;

  RETURN LEAST(1.0, GREATEST(0.0, v_base_score + v_watch_bonus));
END;
$$;

-- 3. Cold start: feed for new users (no profile yet)
CREATE OR REPLACE FUNCTION public.ml_cold_start_feed(p_user_id uuid, p_limit integer DEFAULT 25)
RETURNS TABLE(post_id uuid, score numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_interests text[];
BEGIN
  -- Get user's declared interests from onboarding
  SELECT array_agg(interest) INTO v_interests
  FROM user_interests
  WHERE user_id = p_user_id;

  RETURN QUERY
  SELECT 
    p.id as post_id,
    (
      -- Trending: like velocity in last 24h
      LEAST(1.0, COALESCE(p.likes_count, 0)::numeric / 50.0) * 0.4
      -- Topic match if interests declared
      + CASE 
          WHEN v_interests IS NOT NULL AND pf.topics && v_interests THEN 0.4
          ELSE 0.2
        END
      -- Recency boost
      + GREATEST(0.0, 1.0 - EXTRACT(EPOCH FROM (now() - p.created_at)) / 86400.0) * 0.2
    )::numeric as score
  FROM posts p
  LEFT JOIN ml_post_features pf ON pf.post_id = p.id
  WHERE p.created_at > now() - interval '7 days'
    AND (p.expires_at IS NULL OR p.expires_at > now())
  ORDER BY score DESC
  LIMIT p_limit;
END;
$$;

-- 4. Check if user is in cold start (no signals yet)
CREATE OR REPLACE FUNCTION public.ml_is_cold_start(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM ml_interactions 
    WHERE user_id = p_user_id 
    LIMIT 1
  ) OR NOT EXISTS (
    SELECT 1 FROM ml_user_profiles 
    WHERE user_id = p_user_id AND embedding IS NOT NULL
    LIMIT 1
  );
$$;