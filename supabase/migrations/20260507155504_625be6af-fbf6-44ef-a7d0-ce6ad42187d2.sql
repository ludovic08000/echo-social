
-- ============================================================
-- v5 POST SCORER: neural + classic + watch + momentum + wellbeing
-- ============================================================
CREATE OR REPLACE FUNCTION public.ml_score_post_v5(p_user_id uuid, p_post_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_neural NUMERIC;          -- Two-Tower 256d cosine
  v_classic NUMERIC;         -- v3 (semantic 768d + collab + content + temporal + watch)
  v_user_emb_256 vector;
  v_post_emb_256 vector;
  v_features ml_post_features%ROWTYPE;
  v_velocity NUMERIC := 0;   -- recent engagement velocity (last hour)
  v_velocity_norm NUMERIC := 0;
  v_wellbeing_bonus NUMERIC := 0;
  v_wb_score INTEGER := 50;
  v_positivity NUMERIC := 0.5;
  v_hour INT;
  v_late_penalty NUMERIC := 0;
  v_negative_signal NUMERIC := 0;
  v_final NUMERIC;
BEGIN
  -- 1) Classic blended score (already includes semantic 768 + watch-time)
  BEGIN
    v_classic := public.ml_score_post_v3(p_user_id, p_post_id);
  EXCEPTION WHEN OTHERS THEN
    v_classic := 0.5;
  END;

  -- 2) Neural Two-Tower similarity (256d) — strongest signal when trained
  BEGIN
    EXECUTE 'SELECT embedding FROM ml_user_embeddings WHERE user_id = $1 LIMIT 1'
      INTO v_user_emb_256 USING p_user_id;
    EXECUTE 'SELECT embedding FROM ml_post_embeddings WHERE post_id = $1 LIMIT 1'
      INTO v_post_emb_256 USING p_post_id;
    IF v_user_emb_256 IS NOT NULL AND v_post_emb_256 IS NOT NULL THEN
      v_neural := GREATEST(0.0, LEAST(1.0, 1 - (v_user_emb_256 <=> v_post_emb_256)));
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_neural := NULL;
  END;

  -- 3) Post features (positivity, wellbeing, recent velocity)
  SELECT * INTO v_features FROM ml_post_features WHERE post_id = p_post_id;

  -- Real-time velocity: positive interactions in last hour (capped)
  BEGIN
    SELECT COUNT(*) INTO v_velocity
    FROM ml_interactions
    WHERE post_id = p_post_id
      AND created_at > now() - interval '1 hour'
      AND signal_type IN ('like','comment','share','dwell_long','watch_complete');
    v_velocity_norm := LEAST(1.0, v_velocity / 25.0);  -- 25 strong signals/h = 1.0
  EXCEPTION WHEN OTHERS THEN
    v_velocity_norm := 0;
  END;

  -- Negative feedback (last 24h): hide/skip/report
  BEGIN
    SELECT LEAST(1.0, COUNT(*) / 10.0) INTO v_negative_signal
    FROM ml_interactions
    WHERE post_id = p_post_id
      AND created_at > now() - interval '24 hours'
      AND signal_type IN ('hide','skip_fast','report','dislike');
  EXCEPTION WHEN OTHERS THEN
    v_negative_signal := 0;
  END;

  -- 4) Wellbeing modulation
  v_positivity := COALESCE(v_features.wellbeing_score, GREATEST(0.0, LEAST(1.0, (v_features.sentiment + 1) / 2.0)));

  BEGIN
    SELECT score INTO v_wb_score FROM wellbeing_scores WHERE user_id = p_user_id;
  EXCEPTION WHEN OTHERS THEN
    v_wb_score := 50;
  END;
  -- Low wellbeing → boost positive content more aggressively
  IF v_wb_score < 50 THEN
    v_wellbeing_bonus := (v_positivity - 0.5) * 0.20; -- ±0.10
  ELSE
    v_wellbeing_bonus := (v_positivity - 0.5) * 0.08; -- ±0.04
  END IF;

  -- 5) Time-of-day fatigue dampener (00h-06h): reduce stimulating/high-velocity content
  v_hour := EXTRACT(HOUR FROM now() AT TIME ZONE 'Europe/Paris');
  IF v_hour >= 0 AND v_hour < 6 THEN
    v_late_penalty := v_velocity_norm * 0.10 + (1 - v_positivity) * 0.05;
  END IF;

  -- 6) Final blend
  IF v_neural IS NOT NULL THEN
    -- Neural available: 50% neural / 35% classic / 10% velocity / 5% wellbeing-positivity baseline
    v_final := v_neural * 0.50
             + v_classic * 0.35
             + v_velocity_norm * 0.10
             + v_positivity * 0.05;
  ELSE
    -- No neural: 70% classic / 20% velocity / 10% positivity
    v_final := v_classic * 0.70
             + v_velocity_norm * 0.20
             + v_positivity * 0.10;
  END IF;

  v_final := v_final + v_wellbeing_bonus - v_late_penalty - v_negative_signal * 0.30;

  RETURN GREATEST(0.0, LEAST(1.0, v_final));
END;
$$;

-- ============================================================
-- BATCH WRAPPER v5 (replaces v4 batch route, keeps name stable)
-- ============================================================
CREATE OR REPLACE FUNCTION public.ml_pareto_score_batch(p_user_id uuid, p_post_ids uuid[])
RETURNS TABLE(post_id uuid, score numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_post_id uuid;
  v_score numeric;
BEGIN
  IF p_post_ids IS NULL OR array_length(p_post_ids, 1) IS NULL THEN
    RETURN;
  END IF;
  IF array_length(p_post_ids, 1) > 200 THEN
    RAISE EXCEPTION 'Batch size exceeds limit (200)';
  END IF;

  FOREACH v_post_id IN ARRAY p_post_ids LOOP
    BEGIN
      v_score := public.ml_score_post_v5(p_user_id, v_post_id);
    EXCEPTION WHEN OTHERS THEN
      BEGIN
        v_score := public.ml_score_post_v4(p_user_id, v_post_id);
      EXCEPTION WHEN OTHERS THEN
        v_score := 0.5;
      END;
    END;
    post_id := v_post_id;
    score := COALESCE(v_score, 0.5);
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ml_score_post_v5(uuid, uuid) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.ml_pareto_score_batch(uuid, uuid[]) TO authenticated, anon;

-- ============================================================
-- LIVE SCORE BATCH: rank active streams server-side, wellbeing-aware
-- ============================================================
CREATE OR REPLACE FUNCTION public.live_score_batch(p_user_id uuid, p_limit integer DEFAULT 50)
RETURNS TABLE(
  live_id uuid,
  score numeric,
  momentum numeric,
  affinity numeric,
  interest_match numeric,
  freshness numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_interests text[];
  v_following uuid[];
  v_wb INT := 50;
  v_hour INT := EXTRACT(HOUR FROM now() AT TIME ZONE 'Europe/Paris');
  v_late_penalty NUMERIC := 0;
BEGIN
  -- Build user signal vectors
  IF p_user_id IS NOT NULL THEN
    SELECT array_agg(LOWER(interest_value)) INTO v_interests
    FROM user_interests WHERE user_id = p_user_id;

    SELECT array_agg(CASE WHEN requester_id = p_user_id THEN addressee_id ELSE requester_id END)
    INTO v_following
    FROM friendships
    WHERE status = 'accepted'
      AND (requester_id = p_user_id OR addressee_id = p_user_id);

    BEGIN
      SELECT score INTO v_wb FROM wellbeing_scores WHERE user_id = p_user_id;
    EXCEPTION WHEN OTHERS THEN v_wb := 50; END;
  END IF;

  -- Late-night dampener for very stimulating lives
  IF v_hour >= 0 AND v_hour < 6 THEN
    v_late_penalty := 0.10;
  END IF;

  RETURN QUERY
  WITH momentum_calc AS (
    SELECT
      ls.id,
      ls.user_id,
      ls.viewer_count,
      ls.peak_viewer_count,
      ls.category,
      ls.hashtags,
      ls.started_at,
      -- Momentum: views in last minute / total views (proxy for growth)
      LEAST(1.0,
        COALESCE((
          SELECT COUNT(*)::numeric / 30.0
          FROM live_views lv
          WHERE lv.live_id = ls.id
            AND lv.joined_at > now() - interval '1 minute'
        ), 0)
      ) AS recent_join_rate,
      LEAST(1.0, ls.viewer_count::numeric / 1000.0) AS viewer_norm
    FROM live_streams ls
    WHERE ls.is_active = true
  )
  SELECT
    mc.id AS live_id,
    -- Composite score in [0,1]
    GREATEST(0.0, LEAST(1.0,
        (CASE WHEN v_following IS NOT NULL AND mc.user_id = ANY(v_following) THEN 1.0 ELSE 0.0 END) * 0.30
      + ((mc.recent_join_rate * 0.6) + (mc.viewer_norm * 0.4)) * 0.30
      + (CASE
           WHEN v_interests IS NOT NULL THEN
             LEAST(1.0,
               (
                 SELECT COUNT(*)::numeric
                 FROM unnest(COALESCE(mc.hashtags, ARRAY[]::text[]) || ARRAY[COALESCE(mc.category,'')]) tag
                 WHERE LOWER(tag) = ANY(v_interests)
               ) / GREATEST(1, COALESCE(array_length(mc.hashtags,1), 0) + 1)
             )
           ELSE 0.2
         END) * 0.20
      + (CASE
           WHEN mc.started_at IS NOT NULL THEN
             GREATEST(0.0, 1.0 - EXTRACT(EPOCH FROM (now() - mc.started_at)) / 1800.0) -- 30min freshness
           ELSE 0.5
         END) * 0.15
      + RANDOM() * 0.05
      - (CASE WHEN v_wb < 40 THEN mc.recent_join_rate * v_late_penalty ELSE v_late_penalty * 0.5 END)
    ))::numeric AS score,
    mc.recent_join_rate AS momentum,
    (CASE WHEN v_following IS NOT NULL AND mc.user_id = ANY(v_following) THEN 1.0 ELSE 0.0 END)::numeric AS affinity,
    (CASE
       WHEN v_interests IS NOT NULL THEN
         LEAST(1.0,
           (SELECT COUNT(*)::numeric FROM unnest(COALESCE(mc.hashtags, ARRAY[]::text[]) || ARRAY[COALESCE(mc.category,'')]) tag
            WHERE LOWER(tag) = ANY(v_interests))
           / GREATEST(1, COALESCE(array_length(mc.hashtags,1), 0) + 1))
       ELSE 0.0
     END)::numeric AS interest_match,
    (CASE WHEN mc.started_at IS NOT NULL THEN
        GREATEST(0.0, 1.0 - EXTRACT(EPOCH FROM (now() - mc.started_at)) / 1800.0)
      ELSE 0.5 END)::numeric AS freshness
  FROM momentum_calc mc
  ORDER BY score DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.live_score_batch(uuid, integer) TO authenticated, anon;
