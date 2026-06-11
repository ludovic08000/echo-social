-- ── Tamper event log ──
CREATE TABLE IF NOT EXISTS public.feed_score_tamper_events (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_algo text,
  applied_algo text,
  post_count int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feed_score_tamper_events_user
  ON public.feed_score_tamper_events (user_id, created_at DESC);

ALTER TABLE public.feed_score_tamper_events ENABLE ROW LEVEL SECURITY;

-- Admin-only visibility (uses existing has_role helper)
DROP POLICY IF EXISTS "admin select tamper events" ON public.feed_score_tamper_events;
CREATE POLICY "admin select tamper events"
  ON public.feed_score_tamper_events FOR SELECT
  USING (public.has_role(auth.uid(), 'admin'));

-- No client-side INSERT / UPDATE / DELETE policies → only SECURITY DEFINER
-- functions running with elevated rights can write here.

-- ── Updated feed_score_batch with tamper detection ──
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
  v_saved_algo text;
  v_requested text := COALESCE(p_algo, 'smart');
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

  -- Read saved algo (anti-cheat: client param is a hint only)
  SELECT feed_algorithm INTO v_saved_algo
  FROM public.user_feed_preferences
  WHERE user_id = p_user_id;

  v_algo := COALESCE(v_saved_algo, v_requested);
  IF v_algo NOT IN ('smart','chronological','friends_first') THEN
    v_algo := 'smart';
  END IF;

  -- Tamper detection: client claimed an algo that does not match DB.
  -- We log only when a saved pref exists AND the client sent a non-default mismatch.
  IF v_saved_algo IS NOT NULL
     AND v_requested IN ('smart','chronological','friends_first')
     AND v_requested <> v_saved_algo
  THEN
    BEGIN
      INSERT INTO public.feed_score_tamper_events(user_id, requested_algo, applied_algo, post_count)
      VALUES (p_user_id, v_requested, v_algo, COALESCE(array_length(p_post_ids, 1), 0));
    EXCEPTION WHEN OTHERS THEN
      -- never break ranking on a logging failure
      NULL;
    END;
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
      55 * POWER(0.5, b.age_h / 4.0) AS recency_score,
      LEAST(20, LN(1 + (b.likes_count + b.comments_count * 2.5) / GREATEST(b.age_h, 0.5)) * 5 / LN(2)) AS velocity_score,
      LEAST(30, (b.likes_count * 1 + b.comments_count * 2.5) * 1.5) AS engagement_score,
      CASE
        WHEN b.author_id = p_user_id THEN
          CASE WHEN v_algo = 'friends_first' THEN 60 ELSE 18 END
        WHEN EXISTS (SELECT 1 FROM friends WHERE friend_id = b.author_id) THEN
          CASE WHEN v_algo = 'friends_first' THEN 60 ELSE 18 END
        ELSE 0
      END AS social_score,
      LEAST(12, GREATEST(1, length(COALESCE(b.body,'')) / 80))
        + (CASE WHEN b.body LIKE '%?%' THEN 2 ELSE 0 END)
        + (CASE
            WHEN (length(b.body) - length(replace(b.body, '#', ''))) BETWEEN 1 AND 5 THEN 2
            WHEN (length(b.body) - length(replace(b.body, '#', ''))) > 8 THEN -5
            ELSE 0
          END) AS quality_score,
      (
        SELECT COUNT(*) * 8
        FROM interests i
        WHERE position(i.tag IN lower(COALESCE(b.body,''))) > 0
      ) AS interest_score,
      GREATEST(0, 1 - b.age_h / 12.0) * GREATEST(0, 1 - (b.likes_count + b.comments_count) / 5.0) * 12 AS coldstart_score,
      CASE
        WHEN v_paris_hour BETWEEN 7 AND 9 THEN 1.3
        WHEN v_paris_hour BETWEEN 12 AND 13 THEN 1.3
        WHEN v_paris_hour BETWEEN 18 AND 22 THEN 1.3
        WHEN v_paris_hour BETWEEN 10 AND 11 THEN 1.1
        WHEN v_paris_hour BETWEEN 15 AND 16 THEN 1.0
        ELSE 0.7
      END AS tod_mult,
      CASE
        WHEN b.author_id = p_user_id AND b.age_h < 0.5 THEN 500
        WHEN b.author_id = p_user_id AND b.age_h < 2 THEN 100
        WHEN b.author_id = p_user_id AND b.age_h < 6 THEN 30
        ELSE 0
      END AS own_post_boost
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

-- ── 30-day auto purge ──
CREATE OR REPLACE FUNCTION public.purge_old_feed_score_tamper_events()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.feed_score_tamper_events
  WHERE created_at < now() - interval '30 days';
$$;