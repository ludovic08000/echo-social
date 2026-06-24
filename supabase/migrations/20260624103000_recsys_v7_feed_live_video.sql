-- For Sure RecSys v7
-- Multi-stage, server-side ranking inspired by modern recommender architecture:
-- candidates -> set-based scoring -> stable exploration -> client render.

CREATE INDEX IF NOT EXISTS idx_ml_interactions_user_post_created
  ON public.ml_interactions (user_id, post_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ml_interactions_post_signal_created
  ON public.ml_interactions (post_id, signal_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_posts_feed_candidates
  ON public.posts (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_views_video_viewed
  ON public.video_views (video_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_live_views_live_joined
  ON public.live_views (live_id, joined_at DESC);

ALTER TABLE public.ml_post_features
  ADD COLUMN IF NOT EXISTS avg_watch_time_ms numeric DEFAULT 0,
  ADD COLUMN IF NOT EXISTS watch_sample_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wellbeing_score numeric DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS positive_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS negative_count integer DEFAULT 0;

INSERT INTO public.ml_model_config (key, value, description)
VALUES
  ('recsys_v7_weights', '{
    "ml": 0.52,
    "freshness": 0.16,
    "velocity": 0.10,
    "social": 0.08,
    "quality": 0.07,
    "interest": 0.05,
    "exploration": 0.02
  }'::jsonb, 'For Sure RecSys v7 blend weights for feed_score_batch'),
  ('recsys_v7_exploration', '{
    "daily_bucket_percent": 12,
    "new_creator_boost": 0.08,
    "cold_start_boost": 0.10,
    "max_author_fatigue": 0.22
  }'::jsonb, 'Controlled exploration and fatigue caps')
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value,
    description = EXCLUDED.description,
    updated_at = now();

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
AS $function$
DECLARE
  v_user_id uuid := COALESCE(auth.uid(), p_user_id);
  v_algo text;
  v_now timestamptz := now();
  v_paris_hour int := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Europe/Paris'))::int;
  v_late_night boolean := false;
BEGIN
  IF p_post_ids IS NULL OR array_length(p_post_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  IF array_length(p_post_ids, 1) > 250 THEN
    p_post_ids := p_post_ids[1:250];
  END IF;

  v_late_night := v_paris_hour >= 0 AND v_paris_hour < 6;

  SELECT feed_algorithm INTO v_algo
  FROM public.user_feed_preferences
  WHERE user_id = v_user_id;

  v_algo := COALESCE(v_algo, p_algo, 'smart');
  IF v_algo NOT IN ('smart', 'chronological', 'friends_first') THEN
    v_algo := 'smart';
  END IF;

  RETURN QUERY
  WITH friends AS (
    SELECT CASE WHEN requester_id = v_user_id THEN addressee_id ELSE requester_id END AS friend_id
    FROM public.friendships
    WHERE v_user_id IS NOT NULL
      AND status = 'accepted'
      AND (requester_id = v_user_id OR addressee_id = v_user_id)
  ),
  interests AS (
    SELECT lower(interest_value) AS tag, COALESCE(weight, 1)::numeric AS weight
    FROM public.user_interests
    WHERE user_id = v_user_id
    ORDER BY weight DESC NULLS LAST
    LIMIT 40
  ),
  user_recent_neg AS (
    SELECT mi.post_id, COUNT(*)::numeric AS neg_count
    FROM public.ml_interactions mi
    WHERE mi.user_id = v_user_id
      AND mi.created_at > v_now - interval '30 days'
      AND mi.signal_type IN ('hide', 'not_interested', 'report')
    GROUP BY mi.post_id
  ),
  author_recent AS (
    SELECT p.user_id AS author_id,
      COUNT(*) FILTER (WHERE mi.signal_type IN ('dwell_medium','dwell_long','watch_complete','like','comment','share','save'))::numeric AS pos_count,
      COUNT(*) FILTER (WHERE mi.signal_type IN ('skip_fast','hide','not_interested','report'))::numeric AS neg_count
    FROM public.ml_interactions mi
    JOIN public.posts p ON p.id = mi.post_id
    WHERE mi.user_id = v_user_id
      AND mi.created_at > v_now - interval '48 hours'
    GROUP BY p.user_id
  ),
  ml AS (
    SELECT m.post_id, COALESCE(m.score, 0.5)::numeric AS ml_score
    FROM public.ml_pareto_score_batch(v_user_id, p_post_ids) m
  ),
  base AS (
    SELECT
      p.id AS post_id,
      p.user_id AS author_id,
      p.body,
      p.image_url,
      p.created_at,
      COALESCE(p.likes_count, 0)::numeric AS likes_count,
      COALESCE(p.comments_count, 0)::numeric AS comments_count,
      GREATEST(0.05, EXTRACT(EPOCH FROM (v_now - p.created_at)) / 3600.0)::numeric AS age_h,
      COALESCE(f.quality_score, 0.5)::numeric AS feature_quality,
      COALESCE(f.avg_watch_time_ms, 0)::numeric AS avg_watch_time_ms,
      COALESCE(f.watch_sample_count, 0)::numeric AS watch_sample_count,
      COALESCE(f.positive_count, 0)::numeric AS positive_count,
      COALESCE(f.negative_count, 0)::numeric AS negative_count,
      COALESCE(f.wellbeing_score, 0.5)::numeric AS wellbeing_score
    FROM public.posts p
    LEFT JOIN public.ml_post_features f ON f.post_id = p.id
    WHERE p.id = ANY(p_post_ids)
      AND (p.expires_at IS NULL OR p.expires_at > v_now)
  ),
  scored AS (
    SELECT
      b.*,
      COALESCE(m.ml_score, 0.5)::numeric AS ml_score,
      1.0 * POWER(0.5, b.age_h / 10.0) AS freshness,
      LEAST(1.0, LN(1 + (b.likes_count + b.comments_count * 2.5) / GREATEST(b.age_h, 0.5)) / LN(18)) AS velocity,
      LEAST(1.0, LN(1 + b.likes_count + b.comments_count * 2.0) / LN(120)) AS engagement,
      CASE
        WHEN b.author_id = v_user_id THEN CASE WHEN b.age_h < 2 THEN 1.0 ELSE 0.45 END
        WHEN EXISTS (SELECT 1 FROM friends WHERE friend_id = b.author_id) THEN CASE WHEN v_algo = 'friends_first' THEN 1.0 ELSE 0.60 END
        ELSE 0.15
      END AS social,
      LEAST(1.0,
        b.feature_quality * 0.55
        + LEAST(1.0, b.avg_watch_time_ms / 12000.0) * 0.25
        + b.wellbeing_score * 0.20
      ) AS quality,
      LEAST(1.0, COALESCE((
        SELECT SUM(i.weight) / 12.0
        FROM interests i
        WHERE position(i.tag IN lower(COALESCE(b.body, ''))) > 0
      ), 0)) AS interest,
      CASE
        WHEN b.age_h < 12 AND (b.likes_count + b.comments_count + b.watch_sample_count) < 8 THEN 0.10
        ELSE 0
      END AS cold_start,
      LEAST(0.22, COALESCE(ar.pos_count, 0) * 0.015 + COALESCE(ar.neg_count, 0) * 0.06) AS author_fatigue,
      LEAST(1.0, COALESCE(urn.neg_count, 0) / 2.0) AS user_post_negative,
      (get_byte(decode(substr(md5(COALESCE(v_user_id::text, 'guest') || ':' || b.post_id::text || ':' || date_trunc('day', v_now)::text), 1, 2), 'hex'), 0)::numeric / 255.0) AS stable_explore
    FROM base b
    LEFT JOIN ml m ON m.post_id = b.post_id
    LEFT JOIN author_recent ar ON ar.author_id = b.author_id
    LEFT JOIN user_recent_neg urn ON urn.post_id = b.post_id
  ),
  final AS (
    SELECT
      s.post_id,
      s.ml_score,
      LEAST(100, GREATEST(0,
        s.freshness * 22
        + s.velocity * 16
        + s.engagement * 12
        + s.social * 14
        + s.quality * 14
        + s.interest * 10
        + s.cold_start * 100
      ))::numeric AS classic_score,
      CASE
        WHEN v_algo = 'chronological' THEN EXTRACT(EPOCH FROM s.created_at)::numeric
        ELSE LEAST(100, GREATEST(0,
          (
            s.ml_score * 52
            + s.freshness * 16
            + s.velocity * 10
            + s.social * 8
            + s.quality * 7
            + s.interest * 5
            + s.stable_explore * 2
            + s.cold_start * 100
          )
          - s.author_fatigue * 100
          - s.user_post_negative * 100
          - CASE WHEN v_late_night THEN s.velocity * 8 ELSE 0 END
        ))::numeric
      END AS final_score,
      CASE
        WHEN s.user_post_negative > 0 THEN 'blocked_negative_feedback'
        WHEN s.cold_start > 0 THEN 'cold_start_exploration'
        WHEN s.interest > 0.25 THEN 'interest_match'
        WHEN s.social > 0.5 THEN 'social_affinity'
        ELSE 'personalized_v7'
      END AS reason
    FROM scored s
  )
  SELECT f.post_id, f.final_score, f.ml_score, f.classic_score, f.reason
  FROM final f;
END;
$function$;

REVOKE ALL ON FUNCTION public.feed_score_batch(uuid, uuid[], text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.feed_score_batch(uuid, uuid[], text) TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.get_feed_posts(
  p_user_id uuid,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  body text,
  image_url text,
  created_at timestamptz,
  expires_at timestamptz,
  likes_count integer,
  comments_count integer,
  author_name text,
  author_avatar text,
  author_mood text,
  user_reaction text,
  is_friend boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := COALESCE(auth.uid(), p_user_id);
  v_limit int := GREATEST(1, LEAST(COALESCE(p_limit, 20), 50));
  v_offset int := GREATEST(0, COALESCE(p_offset, 0));
  v_candidate_ids uuid[];
BEGIN
  SELECT array_agg(c.id ORDER BY c.created_at DESC)
  INTO v_candidate_ids
  FROM (
    SELECT p.id, p.created_at
    FROM public.posts p
    WHERE (p.expires_at IS NULL OR p.expires_at > now())
      AND p.created_at > now() - interval '45 days'
      AND (
        v_user_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.ml_interactions mi
          WHERE mi.user_id = v_user_id
            AND mi.post_id = p.id
            AND mi.signal_type IN ('hide', 'not_interested', 'report')
            AND mi.created_at > now() - interval '90 days'
        )
      )
    ORDER BY
      CASE WHEN p.user_id = v_user_id THEN 0 ELSE 1 END,
      p.created_at DESC
    LIMIT 250
  ) c;

  IF v_candidate_ids IS NULL OR array_length(v_candidate_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH friends AS (
    SELECT CASE WHEN requester_id = v_user_id THEN addressee_id ELSE requester_id END AS friend_id
    FROM public.friendships
    WHERE v_user_id IS NOT NULL
      AND status = 'accepted'
      AND (requester_id = v_user_id OR addressee_id = v_user_id)
  ),
  ranked AS (
    SELECT s.post_id, s.final_score
    FROM public.feed_score_batch(v_user_id, v_candidate_ids, 'smart') s
  )
  SELECT
    p.id,
    p.user_id,
    p.body,
    p.image_url,
    p.created_at,
    p.expires_at,
    COALESCE(p.likes_count, 0) AS likes_count,
    COALESCE(p.comments_count, 0) AS comments_count,
    pr.name AS author_name,
    pr.avatar_url AS author_avatar,
    pr.mood_emoji AS author_mood,
    l.reaction_type AS user_reaction,
    EXISTS (SELECT 1 FROM friends f WHERE f.friend_id = p.user_id) AS is_friend
  FROM ranked r
  JOIN public.posts p ON p.id = r.post_id
  JOIN public.profiles pr ON pr.user_id = p.user_id
  LEFT JOIN public.likes l ON l.post_id = p.id AND l.user_id = v_user_id
  ORDER BY r.final_score DESC, p.created_at DESC
  LIMIT v_limit
  OFFSET v_offset;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_feed_posts(uuid, integer, integer) TO authenticated, anon;

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
AS $function$
DECLARE
  v_user_id uuid := COALESCE(auth.uid(), p_user_id);
  v_paris_hour int := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Europe/Paris'))::int;
  v_late_night boolean := false;
  v_following_ids uuid[];
  v_interests text[];
  v_recent_authors uuid[];
  v_seen_ids uuid[];
BEGIN
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;
  IF p_video_ids IS NULL OR array_length(p_video_ids, 1) IS NULL THEN
    RETURN;
  END IF;
  IF array_length(p_video_ids, 1) > 250 THEN
    p_video_ids := p_video_ids[1:250];
  END IF;

  v_late_night := v_paris_hour >= 0 AND v_paris_hour < 6;

  SELECT COALESCE(array_agg(DISTINCT CASE WHEN requester_id = v_user_id THEN addressee_id ELSE requester_id END), '{}')
  INTO v_following_ids
  FROM public.friendships
  WHERE status = 'accepted'
    AND (requester_id = v_user_id OR addressee_id = v_user_id);

  SELECT COALESCE(array_agg(lower(interest_value)), '{}')
  INTO v_interests
  FROM (
    SELECT interest_value
    FROM public.user_interests
    WHERE user_id = v_user_id
    ORDER BY weight DESC NULLS LAST
    LIMIT 40
  ) i;

  SELECT COALESCE(array_agg(DISTINCT vv.video_id), '{}')
  INTO v_seen_ids
  FROM public.video_views vv
  WHERE vv.user_id = v_user_id
    AND vv.viewed_at > now() - interval '14 days'
    AND COALESCE(vv.completion_rate, 0) < 0.35;

  SELECT COALESCE(array_agg(sv.user_id), '{}')
  INTO v_recent_authors
  FROM (
    SELECT vv.video_id
    FROM public.video_views vv
    WHERE vv.user_id = v_user_id
      AND vv.viewed_at > now() - interval '24 hours'
    ORDER BY vv.viewed_at DESC
    LIMIT 40
  ) recent
  JOIN public.short_videos sv ON sv.id = recent.video_id;

  RETURN QUERY
  WITH base AS (
    SELECT
      sv.id,
      sv.user_id,
      sv.hashtags,
      COALESCE(sv.like_count, 0)::numeric AS like_count,
      COALESCE(sv.comment_count, 0)::numeric AS comment_count,
      COALESCE(sv.share_count, 0)::numeric AS share_count,
      COALESCE(sv.view_count, 0)::numeric AS view_count,
      sv.created_at,
      GREATEST(0.05, EXTRACT(EPOCH FROM (now() - sv.created_at)) / 3600.0)::numeric AS age_h,
      COALESCE((
        SELECT AVG(vv.completion_rate)::numeric
        FROM public.video_views vv
        WHERE vv.video_id = sv.id
          AND vv.viewed_at > now() - interval '7 days'
      ), 0.45) AS avg_completion,
      COALESCE((
        SELECT AVG(LEAST(vv.watch_time_seconds::numeric / GREATEST(sv.duration_seconds, 1), 1.5))
        FROM public.video_views vv
        WHERE vv.video_id = sv.id
          AND vv.viewed_at > now() - interval '7 days'
      ), 0.35) AS watch_ratio
    FROM public.short_videos sv
    WHERE sv.id = ANY(p_video_ids)
      AND sv.is_public = true
  ),
  scored AS (
    SELECT
      b.id AS video_id,
      LEAST(1.0, LN(1 + b.like_count * 1.5 + b.comment_count * 3 + b.share_count * 4 + b.view_count * 0.05) / LN(300)) AS eng,
      LEAST(1.0, (b.like_count + b.comment_count * 2 + b.share_count * 3)::numeric / GREATEST(25, b.age_h * 35)) AS vel,
      POWER(0.5, b.age_h / 36.0) AS rec,
      LEAST(1.0, b.avg_completion * 0.65 + b.watch_ratio * 0.35) AS watch_quality,
      CASE WHEN b.user_id = ANY(v_following_ids) THEN 0.22 ELSE 0 END AS follow_boost,
      CASE
        WHEN b.hashtags IS NULL OR array_length(b.hashtags, 1) IS NULL THEN 0
        ELSE LEAST(1.0, (
          SELECT COUNT(*)::numeric
          FROM unnest(b.hashtags) h
          WHERE lower(h) = ANY(v_interests)
        ) / GREATEST(1, array_length(b.hashtags, 1)))
      END AS interest,
      CASE WHEN b.id = ANY(v_seen_ids) THEN 0.18 ELSE 0 END AS seen_penalty,
      CASE
        WHEN v_recent_authors IS NULL OR array_length(v_recent_authors, 1) IS NULL THEN 0
        ELSE LEAST(0.22, (SELECT COUNT(*)::numeric FROM unnest(v_recent_authors) a WHERE a = b.user_id) * 0.045)
      END AS author_fatigue,
      CASE WHEN b.age_h < 12 AND (b.view_count + b.like_count) < 20 THEN 0.10 ELSE 0 END AS cold_start,
      (get_byte(decode(substr(md5(v_user_id::text || ':' || b.id::text || ':' || date_trunc('day', now())::text), 1, 2), 'hex'), 0)::numeric / 255.0) AS explore
    FROM base b
  )
  SELECT
    s.video_id,
    LEAST(1.0, GREATEST(0,
      s.watch_quality * 0.30
      + s.eng * 0.18
      + s.vel * 0.14
      + s.rec * 0.11
      + s.follow_boost
      + s.interest * 0.14
      + s.cold_start
      + s.explore * 0.035
      - s.seen_penalty
      - s.author_fatigue
      - CASE WHEN v_late_night THEN s.vel * 0.12 ELSE 0 END
    ))::numeric AS score,
    s.eng AS engagement_score,
    s.vel AS velocity_score,
    CASE WHEN v_late_night THEN GREATEST(0, 1.0 - s.vel * 0.5) ELSE 1.0 END::numeric AS wellbeing_score
  FROM scored s
  ORDER BY score DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.video_score_batch(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.video_score_batch(uuid, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.live_score_batch(
  p_user_id uuid,
  p_limit integer
)
RETURNS TABLE (
  live_id uuid,
  score numeric,
  engagement_score numeric,
  freshness_score numeric,
  wellbeing_score numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := COALESCE(auth.uid(), p_user_id);
  v_limit int := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
  v_paris_hour int := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Europe/Paris'))::int;
  v_late_night boolean := false;
  v_following_ids uuid[];
  v_interests text[];
  v_recent_authors uuid[];
BEGIN
  v_late_night := v_paris_hour >= 0 AND v_paris_hour < 6;

  IF v_user_id IS NOT NULL THEN
    SELECT COALESCE(array_agg(DISTINCT CASE WHEN requester_id = v_user_id THEN addressee_id ELSE requester_id END), '{}')
    INTO v_following_ids
    FROM public.friendships
    WHERE status = 'accepted'
      AND (requester_id = v_user_id OR addressee_id = v_user_id);

    SELECT COALESCE(array_agg(lower(interest_value)), '{}')
    INTO v_interests
    FROM (
      SELECT interest_value
      FROM public.user_interests
      WHERE user_id = v_user_id
      ORDER BY weight DESC NULLS LAST
      LIMIT 40
    ) i;

    SELECT COALESCE(array_agg(ls.user_id), '{}')
    INTO v_recent_authors
    FROM (
      SELECT lv.live_id
      FROM public.live_views lv
      WHERE lv.user_id = v_user_id
        AND lv.joined_at > now() - interval '24 hours'
      ORDER BY lv.joined_at DESC
      LIMIT 25
    ) recent
    JOIN public.live_streams ls ON ls.id = recent.live_id;
  ELSE
    v_following_ids := '{}';
    v_interests := '{}';
    v_recent_authors := '{}';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      ls.id,
      ls.user_id,
      ls.category,
      ls.hashtags,
      COALESCE(ls.viewer_count, 0)::numeric AS viewer_count,
      COALESCE(ls.peak_viewer_count, 0)::numeric AS peak_viewer_count,
      COALESCE(ls.total_views, 0)::numeric AS total_views,
      COALESCE(ls.started_at, ls.created_at) AS started_at,
      GREATEST(0.05, EXTRACT(EPOCH FROM (now() - COALESCE(ls.started_at, ls.created_at))) / 3600.0)::numeric AS age_h,
      COALESCE((
        SELECT COUNT(*)::numeric
        FROM public.live_views lv
        WHERE lv.live_id = ls.id
          AND lv.joined_at > now() - interval '2 minutes'
      ), 0) AS recent_joins
    FROM public.live_streams ls
    WHERE ls.is_active = true
  ),
  scored AS (
    SELECT
      b.id AS live_id,
      LEAST(1.0, (b.viewer_count * 0.55 + b.peak_viewer_count * 0.20 + b.recent_joins * 8 + b.total_views * 0.01) / 350.0) AS eng,
      POWER(0.5, b.age_h / 2.5) AS fresh,
      CASE WHEN b.user_id = ANY(v_following_ids) THEN 0.28 ELSE 0 END AS follow_boost,
      CASE
        WHEN COALESCE(array_length(b.hashtags, 1), 0) = 0 AND b.category IS NULL THEN 0
        ELSE LEAST(1.0, (
          SELECT COUNT(*)::numeric
          FROM unnest(COALESCE(b.hashtags, ARRAY[]::text[]) || ARRAY[COALESCE(b.category, '')]) tag
          WHERE lower(tag) = ANY(v_interests)
        ) / GREATEST(1, COALESCE(array_length(b.hashtags, 1), 0) + 1))
      END AS interest,
      CASE
        WHEN v_recent_authors IS NULL OR array_length(v_recent_authors, 1) IS NULL THEN 0
        ELSE LEAST(0.20, (SELECT COUNT(*)::numeric FROM unnest(v_recent_authors) a WHERE a = b.user_id) * 0.065)
      END AS author_fatigue,
      (get_byte(decode(substr(md5(COALESCE(v_user_id::text, 'guest') || ':' || b.id::text || ':' || date_trunc('hour', now())::text), 1, 2), 'hex'), 0)::numeric / 255.0) AS explore
    FROM base b
  )
  SELECT
    s.live_id,
    LEAST(1.0, GREATEST(0,
      s.eng * 0.36
      + s.fresh * 0.22
      + s.follow_boost
      + s.interest * 0.18
      + s.explore * 0.04
      - s.author_fatigue
      - CASE WHEN v_late_night THEN s.eng * 0.13 ELSE 0 END
    ))::numeric AS score,
    s.eng AS engagement_score,
    s.fresh AS freshness_score,
    CASE WHEN v_late_night THEN GREATEST(0, 1.0 - s.eng * 0.5) ELSE 1.0 END::numeric AS wellbeing_score
  FROM scored s
  ORDER BY score DESC
  LIMIT v_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.live_score_batch(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.live_score_batch(uuid, integer) TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.live_feed_bundle(
  p_user_id uuid,
  p_active_limit integer DEFAULT 80,
  p_replay_limit integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id uuid := COALESCE(auth.uid(), p_user_id);
  v_active jsonb;
  v_replays jsonb;
  v_profiles jsonb;
  v_ranks jsonb;
BEGIN
  WITH ranks AS (
    SELECT * FROM public.live_score_batch(v_user_id, p_active_limit)
  ),
  active AS (
    SELECT
      ls.id, ls.title, ls.description, ls.thumbnail_url, ls.is_active,
      ls.viewer_count, ls.peak_viewer_count, ls.total_views, ls.category, ls.hashtags,
      ls.user_id, ls.recording_url, ls.started_at, ls.created_at,
      NULL::timestamptz AS ended_at,
      COALESCE(r.score, 0)::numeric AS score
    FROM public.live_streams ls
    LEFT JOIN ranks r ON r.live_id = ls.id
    WHERE ls.is_active = true
    ORDER BY COALESCE(r.score, 0) DESC, ls.viewer_count DESC, COALESCE(ls.started_at, ls.created_at) DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_active_limit, 80), 200))
  )
  SELECT
    COALESCE(jsonb_agg(row_to_json(active)), '[]'::jsonb),
    COALESCE(jsonb_object_agg(active.id, active.score), '{}'::jsonb)
  INTO v_active, v_ranks
  FROM active;

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
  INTO v_replays
  FROM (
    SELECT
      ls.id, ls.title, ls.description, ls.thumbnail_url, ls.is_active,
      ls.viewer_count, ls.peak_viewer_count, ls.total_views, ls.category, ls.hashtags,
      ls.user_id, ls.recording_url, ls.started_at, ls.created_at, ls.ended_at
    FROM public.live_streams ls
    WHERE ls.is_active = false
      AND ls.ended_at IS NOT NULL
    ORDER BY ls.ended_at DESC
    LIMIT GREATEST(0, LEAST(COALESCE(p_replay_limit, 30), 100))
  ) t;

  SELECT COALESCE(jsonb_agg(row_to_json(p)), '[]'::jsonb)
  INTO v_profiles
  FROM (
    SELECT pr.user_id, pr.name, pr.avatar_url
    FROM public.profiles pr
    WHERE pr.user_id IN (
      SELECT DISTINCT ls.user_id
      FROM public.live_streams ls
      WHERE ls.is_active = true
         OR (ls.is_active = false AND ls.ended_at IS NOT NULL AND ls.ended_at > now() - interval '90 days')
      LIMIT 250
    )
  ) p;

  RETURN jsonb_build_object(
    'active', v_active,
    'replays', v_replays,
    'profiles', v_profiles,
    'ranks', COALESCE(v_ranks, '{}'::jsonb),
    'generated_at', extract(epoch from now())
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.live_feed_bundle(uuid, integer, integer) TO authenticated, anon;
