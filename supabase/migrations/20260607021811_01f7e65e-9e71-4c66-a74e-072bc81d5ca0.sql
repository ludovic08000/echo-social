-- video_score_batch — Server-side ranking for short videos (anti-tamper)
-- Mirrors structure of feed_score_batch / live_score_batch (v5 engine)

CREATE OR REPLACE FUNCTION public.video_score_batch(
  p_user_id uuid,
  p_video_ids uuid[]
)
RETURNS TABLE (
  video_id uuid,
  score numeric,
  engagement_score numeric,
  velocity_score numeric,
  wellbeing_score numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_paris_hour int;
  v_late_night boolean;
  v_following_ids uuid[];
  v_interests text[];
  v_viewed_ids uuid[];
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Anti-cheat: ignore p_user_id from client, use auth.uid()
  p_user_id := v_caller;

  IF p_video_ids IS NULL OR array_length(p_video_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- Paris late-night dampener (00–06h)
  v_paris_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Europe/Paris'))::int;
  v_late_night := v_paris_hour >= 0 AND v_paris_hour < 6;

  -- Following list
  SELECT COALESCE(array_agg(DISTINCT CASE WHEN requester_id = p_user_id THEN addressee_id ELSE requester_id END), '{}')
    INTO v_following_ids
  FROM public.friendships
  WHERE status = 'accepted'
    AND (requester_id = p_user_id OR addressee_id = p_user_id);

  -- User interests
  SELECT COALESCE(array_agg(interest_value), '{}') INTO v_interests
  FROM (
    SELECT interest_value
    FROM public.user_interests
    WHERE user_id = p_user_id
    ORDER BY weight DESC NULLS LAST
    LIMIT 30
  ) s;

  -- Recently viewed
  SELECT COALESCE(array_agg(DISTINCT vv.video_id), '{}') INTO v_viewed_ids
  FROM public.video_views vv
  WHERE vv.user_id = p_user_id
    AND vv.viewed_at > now() - interval '7 days';

  RETURN QUERY
  WITH base AS (
    SELECT
      sv.id,
      sv.user_id,
      sv.hashtags,
      sv.like_count,
      sv.comment_count,
      sv.share_count,
      sv.view_count,
      sv.created_at,
      GREATEST(0.001, EXTRACT(EPOCH FROM (now() - sv.created_at)) / 3600.0) AS age_hours
    FROM public.short_videos sv
    WHERE sv.id = ANY(p_video_ids)
      AND sv.is_public = true
  ),
  scored AS (
    SELECT
      b.id AS video_id,
      -- engagement (normalized roughly 0..1)
      LEAST(1.0, (b.like_count * 0.3 + b.comment_count * 0.5 + b.share_count * 0.7 + b.view_count * 0.05) / 1000.0)::numeric AS eng,
      -- velocity: engagement per hour, capped
      LEAST(1.0, (b.like_count + b.comment_count * 2 + b.share_count * 3)::numeric / (b.age_hours * 50.0))::numeric AS vel,
      -- recency decay over 7 days
      GREATEST(0, 1.0 - (b.age_hours / 168.0))::numeric AS rec,
      -- following bonus
      CASE WHEN b.user_id = ANY(v_following_ids) THEN 0.25 ELSE 0 END::numeric AS foll,
      -- interest match
      CASE
        WHEN b.hashtags IS NULL OR array_length(b.hashtags, 1) IS NULL THEN 0
        ELSE LEAST(1.0,
          (SELECT COUNT(*)::numeric FROM unnest(b.hashtags) h WHERE lower(h) = ANY(SELECT lower(i) FROM unnest(v_interests) i))
          / GREATEST(1, array_length(b.hashtags, 1))
        )
      END::numeric AS interest,
      -- view penalty
      CASE WHEN b.id = ANY(v_viewed_ids) THEN -0.15 ELSE 0 END::numeric AS view_pen,
      -- freshness boost (<6h)
      CASE WHEN b.age_hours < 6 THEN 0.10 ELSE 0 END::numeric AS fresh
    FROM base b
  )
  SELECT
    s.video_id,
    LEAST(1.0, GREATEST(0,
      s.eng * 0.30
      + s.vel * 0.15
      + s.rec * 0.10
      + s.foll
      + s.interest * 0.20
      + s.view_pen
      + s.fresh
      -- wellbeing dampener for high-arousal velocity late at night
      - CASE WHEN v_late_night THEN s.vel * 0.20 ELSE 0 END
    ))::numeric AS score,
    s.eng AS engagement_score,
    s.vel AS velocity_score,
    CASE WHEN v_late_night THEN GREATEST(0, 1.0 - s.vel * 0.5) ELSE 1.0 END::numeric AS wellbeing_score
  FROM scored s
  ORDER BY score DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.video_score_batch(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.video_score_batch(uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.video_score_batch IS
  'Server-side ranking for short_videos. Anti-tamper (uses auth.uid()), wellbeing-aware (late-night dampener Paris 00-06h).';
