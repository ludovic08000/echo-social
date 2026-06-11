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
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_following uuid[];
  v_interests text[];
  v_hour int := EXTRACT(HOUR FROM now() AT TIME ZONE 'Europe/Paris');
  v_late_penalty numeric := 0;
  v_algo text := COALESCE(NULLIF(lower(p_algo), ''), 'smart');
BEGIN
  IF p_post_ids IS NULL OR array_length(p_post_ids, 1) IS NULL THEN
    RETURN;
  END IF;
  IF array_length(p_post_ids, 1) > 200 THEN
    RAISE EXCEPTION 'Batch size exceeds limit (200)';
  END IF;
  IF v_algo NOT IN ('smart', 'chronological', 'friends_first') THEN
    v_algo := 'smart';
  END IF;

  IF p_user_id IS NOT NULL AND v_algo <> 'chronological' THEN
    SELECT array_agg(CASE WHEN requester_id = p_user_id THEN addressee_id ELSE requester_id END)
    INTO v_following
    FROM friendships
    WHERE status = 'accepted'
      AND (requester_id = p_user_id OR addressee_id = p_user_id);

    BEGIN
      SELECT array_agg(LOWER(interest_value)) INTO v_interests
      FROM user_interests WHERE user_id = p_user_id;
    EXCEPTION WHEN OTHERS THEN v_interests := NULL; END;
  END IF;

  IF v_hour >= 0 AND v_hour < 6 THEN
    v_late_penalty := 0.10;
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      p.id,
      p.user_id,
      p.body,
      p.image_url,
      p.created_at,
      p.likes_count,
      p.comments_count,
      GREATEST(0.001::numeric, (EXTRACT(EPOCH FROM (now() - p.created_at)) / 3600.0)::numeric) AS age_hours,
      (p.user_id = p_user_id) AS is_own,
      (v_following IS NOT NULL AND p.user_id = ANY(v_following)) AS is_friend
    FROM posts p
    WHERE p.id = ANY(p_post_ids)
  ),
  scored AS (
    SELECT
      b.*,
      (55.0 * power(0.5::numeric, b.age_hours / 4.0))::numeric AS s_recency,
      LEAST(20.0::numeric, (LN(1 + (b.likes_count + b.comments_count * 2.5) / GREATEST(0.5::numeric, b.age_hours)) * 5 / LN(2))::numeric) AS s_velocity,
      LEAST(30.0::numeric, ((b.likes_count * 1.0 + b.comments_count * 2.5) * 1.5)::numeric) AS s_engagement,
      (CASE
        WHEN v_algo = 'friends_first' THEN (CASE WHEN b.is_friend OR b.is_own THEN 60 ELSE -10 END)
        WHEN b.is_friend OR b.is_own THEN 18
        ELSE 0
      END)::numeric AS s_social,
      (CASE
        WHEN NOT b.is_friend AND NOT b.is_own
          THEN CASE WHEN b.age_hours < 6 THEN 15 ELSE 8 END
        ELSE 0
      END)::numeric AS s_discovery,
      (
        CASE WHEN b.image_url IS NOT NULL THEN 12 ELSE 0 END +
        CASE
          WHEN length(b.body) BETWEEN 80 AND 400 THEN 10
          WHEN length(b.body) > 400 AND length(b.body) <= 800 THEN 7
          WHEN length(b.body) > 20 AND length(b.body) < 80 THEN 4
          WHEN length(b.body) <= 20 THEN 1
          ELSE 0
        END +
        CASE WHEN b.body LIKE '%?%' THEN 3 ELSE 0 END +
        CASE
          WHEN (length(regexp_replace(b.body, '[^#]', '', 'g')) BETWEEN 1 AND 5) THEN 2
          WHEN (length(regexp_replace(b.body, '[^#]', '', 'g')) > 8) THEN -5
          ELSE 0
        END
      )::numeric AS s_quality,
      (CASE
        WHEN v_interests IS NULL OR array_length(v_interests, 1) IS NULL THEN 0
        ELSE LEAST(20,
          (SELECT COUNT(*)::int FROM unnest(v_interests) AS i WHERE position(i IN lower(b.body)) > 0) * 8
        )
      END)::numeric AS s_interest,
      (CASE
        WHEN (b.likes_count + b.comments_count) <= 5 AND b.age_hours <= 12
          THEN GREATEST(0::numeric, 1 - b.age_hours / 12.0) * GREATEST(0::numeric, 1 - (b.likes_count + b.comments_count) / 5.0) * 12
        ELSE 0::numeric
      END)::numeric AS s_coldstart,
      ((CASE
        WHEN EXTRACT(HOUR FROM b.created_at) BETWEEN 7 AND 9
          OR EXTRACT(HOUR FROM b.created_at) BETWEEN 12 AND 14
          OR EXTRACT(HOUR FROM b.created_at) BETWEEN 18 AND 23 THEN 1.3
        WHEN EXTRACT(HOUR FROM b.created_at) BETWEEN 10 AND 11 THEN 1.1
        WHEN EXTRACT(HOUR FROM b.created_at) BETWEEN 15 AND 17 THEN 1.0
        ELSE 0.7
      END - 1.0) * 15)::numeric AS s_timeofday,
      (CASE
        WHEN b.is_own AND b.age_hours < 0.5 THEN 500
        WHEN b.is_own AND b.age_hours < 2 THEN 100
        WHEN b.is_own AND b.age_hours < 6 THEN 30
        ELSE 0
      END)::numeric AS s_own
    FROM base b
  ),
  classic AS (
    SELECT
      s.id,
      (CASE
        WHEN v_algo = 'chronological' THEN EXTRACT(EPOCH FROM s.created_at)
        ELSE (
          s.s_recency + s.s_velocity + s.s_engagement +
          s.s_social + s.s_discovery + s.s_quality +
          s.s_interest + s.s_coldstart + s.s_timeofday + s.s_own
        )
      END)::numeric AS classic_raw
    FROM scored s
  )
  SELECT
    c.id AS post_id,
    (CASE
      WHEN v_algo = 'chronological' THEN c.classic_raw
      ELSE (
        (LEAST(1.0::numeric, GREATEST(0.0::numeric, c.classic_raw / 200.0)) * 0.45)
        + (COALESCE(ml.score, 0.5::numeric) * 0.55)
      ) * (1.0 - v_late_penalty)
    END)::numeric AS final_score,
    COALESCE(ml.score, 0.5::numeric)::numeric AS ml_score,
    LEAST(1.0::numeric, GREATEST(0.0::numeric, c.classic_raw / 200.0))::numeric AS classic_score,
    v_algo AS reason
  FROM classic c
  LEFT JOIN LATERAL (
    SELECT score FROM public.ml_pareto_score_batch(p_user_id, ARRAY[c.id]) LIMIT 1
  ) ml ON v_algo <> 'chronological';
END;
$$;