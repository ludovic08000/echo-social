-- ── user_feed_preferences ──
CREATE TABLE IF NOT EXISTS public.user_feed_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  feed_algorithm text NOT NULL DEFAULT 'smart',
  diversity_boost int NOT NULL DEFAULT 50,
  muted_keywords text[] NOT NULL DEFAULT ARRAY[]::text[],
  priority_topics text[] NOT NULL DEFAULT ARRAY[]::text[],
  viral_content_reduce boolean NOT NULL DEFAULT false,
  sensitive_content_filter boolean NOT NULL DEFAULT true,
  seen_posts_hide boolean NOT NULL DEFAULT false,
  weight_friends int NOT NULL DEFAULT 60,
  weight_discovery int NOT NULL DEFAULT 30,
  weight_marketplace int NOT NULL DEFAULT 10,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_feed_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner select feed prefs"
  ON public.user_feed_preferences FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "owner insert feed prefs"
  ON public.user_feed_preferences FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner update feed prefs"
  ON public.user_feed_preferences FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "owner delete feed prefs"
  ON public.user_feed_preferences FOR DELETE
  USING (auth.uid() = user_id);

-- ── Validation trigger (server-side bounds, anti-cheat) ──
CREATE OR REPLACE FUNCTION public.validate_user_feed_preferences()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Algorithm mode whitelist
  IF NEW.feed_algorithm NOT IN ('smart','chronological','friends_first') THEN
    NEW.feed_algorithm := 'smart';
  END IF;

  -- Numeric bounds 0..100
  NEW.diversity_boost := GREATEST(0, LEAST(100, NEW.diversity_boost));
  NEW.weight_friends := GREATEST(0, LEAST(100, NEW.weight_friends));
  NEW.weight_discovery := GREATEST(0, LEAST(100, NEW.weight_discovery));
  NEW.weight_marketplace := GREATEST(0, LEAST(100, NEW.weight_marketplace));

  -- Keyword arrays: cap length and item size
  IF NEW.muted_keywords IS NULL THEN
    NEW.muted_keywords := ARRAY[]::text[];
  END IF;
  IF array_length(NEW.muted_keywords, 1) > 100 THEN
    NEW.muted_keywords := NEW.muted_keywords[1:100];
  END IF;
  NEW.muted_keywords := ARRAY(
    SELECT lower(substring(trim(k) from 1 for 60))
    FROM unnest(NEW.muted_keywords) k
    WHERE length(trim(k)) > 0
  );

  IF NEW.priority_topics IS NULL THEN
    NEW.priority_topics := ARRAY[]::text[];
  END IF;
  IF array_length(NEW.priority_topics, 1) > 50 THEN
    NEW.priority_topics := NEW.priority_topics[1:50];
  END IF;
  NEW.priority_topics := ARRAY(
    SELECT lower(substring(trim(t) from 1 for 40))
    FROM unnest(NEW.priority_topics) t
    WHERE length(trim(t)) > 0
  );

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_user_feed_preferences ON public.user_feed_preferences;
CREATE TRIGGER trg_validate_user_feed_preferences
  BEFORE INSERT OR UPDATE ON public.user_feed_preferences
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_user_feed_preferences();

-- ── Anti-cheat: feed_score_batch reads algo from DB ──
-- Client may pass p_algo as a hint, but if it doesn't match the user's
-- saved feed_algorithm, the server falls back to the DB value.
CREATE OR REPLACE FUNCTION public.feed_score_batch(
  p_user_id uuid,
  p_post_ids uuid[],
  p_algo text DEFAULT 'smart'
)
RETURNS TABLE(
  post_id uuid,
  final_score numeric,
  ml_score numeric,
  classic_score numeric,
  reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_algo text;
  v_now timestamptz := now();
  v_paris_hour int := EXTRACT(HOUR FROM (v_now AT TIME ZONE 'Europe/Paris'))::int;
  v_late_penalty numeric := CASE WHEN v_paris_hour BETWEEN 0 AND 5 THEN 0.25 ELSE 0 END;
BEGIN
  IF p_post_ids IS NULL OR array_length(p_post_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  IF array_length(p_post_ids, 1) > 200 THEN
    p_post_ids := p_post_ids[1:200];
  END IF;

  -- Read DB-backed algorithm (anti-cheat: client param is a hint only)
  SELECT feed_algorithm INTO v_algo
  FROM public.user_feed_preferences
  WHERE user_id = p_user_id;

  IF v_algo IS NULL THEN
    -- Fallback: trust client hint when no DB pref yet
    v_algo := COALESCE(p_algo, 'smart');
  END IF;

  IF v_algo NOT IN ('smart','chronological','friends_first') THEN
    v_algo := 'smart';
  END IF;

  RETURN QUERY
  WITH friends AS (
    SELECT CASE WHEN requester_id = p_user_id THEN addressee_id ELSE requester_id END AS friend_id
    FROM public.friendships
    WHERE status = 'accepted'
      AND (requester_id = p_user_id OR addressee_id = p_user_id)
  ),
  interests AS (
    SELECT lower(interest_value) AS tag
    FROM public.user_interests
    WHERE user_id = p_user_id
  ),
  ml AS (
    SELECT m.post_id, COALESCE(m.score, 0.5)::numeric AS ml_score
    FROM public.ml_pareto_score_batch(p_user_id, p_post_ids) m
  ),
  base AS (
    SELECT
      p.id AS post_id,
      p.user_id AS author_id,
      p.body,
      p.created_at,
      COALESCE(p.likes_count, 0) AS likes_count,
      COALESCE(p.comments_count, 0) AS comments_count,
      EXTRACT(EPOCH FROM (v_now - p.created_at)) / 3600.0 AS age_h
    FROM public.posts p
    WHERE p.id = ANY(p_post_ids)
  ),
  scored AS (
    SELECT
      b.post_id,
      b.author_id,
      b.created_at,
      -- Recency (half-life 4h, max 55)
      55 * POWER(0.5, b.age_h / 4.0) AS recency_score,
      -- Engagement velocity (capped 20)
      LEAST(20, LN(1 + (b.likes_count + b.comments_count * 2.5) / GREATEST(b.age_h, 0.5)) * 5 / LN(2)) AS velocity_score,
      -- Raw engagement (capped 30)
      LEAST(30, (b.likes_count * 1 + b.comments_count * 2.5) * 1.5) AS engagement_score,
      -- Social proximity
      CASE
        WHEN b.author_id = p_user_id THEN
          CASE WHEN v_algo = 'friends_first' THEN 60 ELSE 18 END
        WHEN EXISTS (SELECT 1 FROM friends WHERE friend_id = b.author_id) THEN
          CASE WHEN v_algo = 'friends_first' THEN 60 ELSE 18 END
        ELSE 0
      END AS social_score,
      -- Content quality
      LEAST(12, GREATEST(1, length(COALESCE(b.body,'')) / 80))
        + (CASE WHEN b.body LIKE '%?%' THEN 2 ELSE 0 END)
        + (CASE
            WHEN (length(b.body) - length(replace(b.body, '#', ''))) BETWEEN 1 AND 5 THEN 2
            WHEN (length(b.body) - length(replace(b.body, '#', ''))) > 8 THEN -5
            ELSE 0
          END) AS quality_score,
      -- Interest affinity
      (
        SELECT COUNT(*) * 8
        FROM interests i
        WHERE position(i.tag IN lower(COALESCE(b.body,''))) > 0
      ) AS interest_score,
      -- Cold-start boost
      GREATEST(0, 1 - b.age_h / 12.0) * GREATEST(0, 1 - (b.likes_count + b.comments_count) / 5.0) * 12 AS coldstart_score,
      -- Time-of-day multiplier
      CASE
        WHEN v_paris_hour BETWEEN 7 AND 9 THEN 1.3
        WHEN v_paris_hour BETWEEN 12 AND 13 THEN 1.3
        WHEN v_paris_hour BETWEEN 18 AND 22 THEN 1.3
        WHEN v_paris_hour BETWEEN 10 AND 11 THEN 1.1
        WHEN v_paris_hour BETWEEN 15 AND 16 THEN 1.0
        ELSE 0.7
      END AS tod_mult,
      -- Own post boost (recent)
      CASE
        WHEN b.author_id = p_user_id AND b.age_h < 0.5 THEN 500
        WHEN b.author_id = p_user_id AND b.age_h < 2 THEN 100
        WHEN b.author_id = p_user_id AND b.age_h < 6 THEN 30
        ELSE 0
      END AS own_post_boost,
      b.body,
      b.age_h
    FROM base b
  ),
  final AS (
    SELECT
      s.post_id,
      COALESCE(m.ml_score, 0.5)::numeric AS ml_score,
      ((s.recency_score + s.velocity_score + s.engagement_score
        + s.social_score + s.quality_score + s.interest_score
        + s.coldstart_score) * s.tod_mult + s.own_post_boost)::numeric AS classic_score,
      CASE
        WHEN v_algo = 'chronological' THEN
          EXTRACT(EPOCH FROM s.created_at)::numeric
        ELSE
          ((
            ((s.recency_score + s.velocity_score + s.engagement_score
              + s.social_score + s.quality_score + s.interest_score
              + s.coldstart_score) * s.tod_mult + s.own_post_boost) * 0.45
            + COALESCE(m.ml_score, 0.5) * 100 * 0.55
          ) * (1 - v_late_penalty))::numeric
      END AS final_score,
      v_algo AS reason
    FROM scored s
    LEFT JOIN ml m ON m.post_id = s.post_id
  )
  SELECT f.post_id, f.final_score, f.ml_score, f.classic_score, f.reason
  FROM final f;
END;
$$;

GRANT EXECUTE ON FUNCTION public.feed_score_batch(uuid, uuid[], text) TO authenticated, anon;