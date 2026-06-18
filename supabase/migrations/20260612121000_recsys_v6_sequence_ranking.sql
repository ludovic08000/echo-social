-- Recsys v6: sequence-aware video/live ranking.
-- Inspired by public Meta/TikTok recommender-system disclosures:
-- recent event sequences, watch/completion strength, negative feedback,
-- diversity/repetition control, controlled exploration and fresh models.

CREATE INDEX IF NOT EXISTS idx_ml_interactions_user_signal_created
  ON public.ml_interactions(user_id, signal_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_views_user_viewed
  ON public.video_views(user_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_views_user_video_viewed
  ON public.video_views(user_id, video_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_live_views_user_joined
  ON public.live_views(user_id, joined_at DESC);

CREATE INDEX IF NOT EXISTS idx_live_views_live_joined
  ON public.live_views(live_id, joined_at DESC);

CREATE INDEX IF NOT EXISTS idx_live_streams_active_started
  ON public.live_streams(started_at DESC)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_short_videos_public_created
  ON public.short_videos(created_at DESC)
  WHERE is_public = true;

CREATE INDEX IF NOT EXISTS idx_short_videos_sound_name
  ON public.short_videos(sound_name)
  WHERE sound_name IS NOT NULL;

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
  v_paris_hour int := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Europe/Paris'))::int;
  v_late_night boolean := false;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Anti-cheat: client may pass p_user_id, but authenticated user wins.
  p_user_id := v_caller;
  v_late_night := v_paris_hour >= 0 AND v_paris_hour < 6;

  IF p_video_ids IS NULL OR array_length(p_video_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  IF array_length(p_video_ids, 1) > 200 THEN
    p_video_ids := p_video_ids[1:200];
  END IF;

  RETURN QUERY
  WITH input_ids AS (
    SELECT DISTINCT unnest(p_video_ids) AS id
  ),
  following AS (
    SELECT DISTINCT CASE
      WHEN requester_id = p_user_id THEN addressee_id
      ELSE requester_id
    END AS user_id
    FROM public.friendships
    WHERE status = 'accepted'
      AND (requester_id = p_user_id OR addressee_id = p_user_id)
  ),
  interests AS (
    SELECT lower(interest_value) AS tag, GREATEST(0.1, COALESCE(weight, 1))::numeric AS weight
    FROM public.user_interests
    WHERE user_id = p_user_id
  ),
  recent_views AS (
    SELECT
      vv.video_id,
      count(*) AS views,
      avg(GREATEST(0, LEAST(1, vv.completion_rate::numeric))) AS avg_completion,
      avg(GREATEST(0, LEAST(1, vv.watch_time_seconds::numeric / GREATEST(1, sv.duration_seconds)))) AS avg_watch_ratio,
      max(vv.viewed_at) AS last_viewed_at,
      bool_or(vv.replayed) AS replayed
    FROM public.video_views vv
    JOIN public.short_videos sv ON sv.id = vv.video_id
    WHERE vv.user_id = p_user_id
      AND vv.viewed_at > now() - interval '14 days'
    GROUP BY vv.video_id
  ),
  history_tags AS (
    SELECT
      lower(tag) AS tag,
      sum(
        GREATEST(0, LEAST(1, vv.completion_rate::numeric))
        + GREATEST(0, LEAST(1, vv.watch_time_seconds::numeric / GREATEST(1, sv.duration_seconds))) * 0.8
        + CASE WHEN vv.replayed THEN 0.35 ELSE 0 END
      ) AS affinity
    FROM public.video_views vv
    JOIN public.short_videos sv ON sv.id = vv.video_id
    CROSS JOIN LATERAL unnest(COALESCE(sv.hashtags, ARRAY[]::text[])) AS tag
    WHERE vv.user_id = p_user_id
      AND vv.viewed_at > now() - interval '21 days'
      AND (vv.completion_rate >= 0.35 OR vv.watch_time_seconds >= 3 OR vv.replayed)
    GROUP BY lower(tag)
  ),
  history_sounds AS (
    SELECT
      lower(sv.sound_name) AS sound_name,
      sum(
        GREATEST(0, LEAST(1, vv.completion_rate::numeric))
        + CASE WHEN vv.replayed THEN 0.35 ELSE 0 END
      ) AS affinity
    FROM public.video_views vv
    JOIN public.short_videos sv ON sv.id = vv.video_id
    WHERE vv.user_id = p_user_id
      AND sv.sound_name IS NOT NULL
      AND vv.viewed_at > now() - interval '21 days'
      AND (vv.completion_rate >= 0.35 OR vv.replayed)
    GROUP BY lower(sv.sound_name)
  ),
  recent_author_exposure AS (
    SELECT sv.user_id, count(*) AS seen_count
    FROM public.video_views vv
    JOIN public.short_videos sv ON sv.id = vv.video_id
    WHERE vv.user_id = p_user_id
      AND vv.viewed_at > now() - interval '12 hours'
    GROUP BY sv.user_id
  ),
  recent_sound_exposure AS (
    SELECT lower(sv.sound_name) AS sound_name, count(*) AS seen_count
    FROM public.video_views vv
    JOIN public.short_videos sv ON sv.id = vv.video_id
    WHERE vv.user_id = p_user_id
      AND sv.sound_name IS NOT NULL
      AND vv.viewed_at > now() - interval '12 hours'
    GROUP BY lower(sv.sound_name)
  ),
  global_quality AS (
    SELECT
      vv.video_id,
      avg(GREATEST(0, LEAST(1, vv.completion_rate::numeric))) AS avg_completion,
      avg(GREATEST(0, LEAST(1, vv.watch_time_seconds::numeric / GREATEST(1, sv.duration_seconds)))) AS avg_watch_ratio,
      count(*) AS samples
    FROM public.video_views vv
    JOIN public.short_videos sv ON sv.id = vv.video_id
    WHERE vv.video_id IN (SELECT id FROM input_ids)
      AND vv.viewed_at > now() - interval '7 days'
    GROUP BY vv.video_id
  ),
  base AS (
    SELECT
      sv.id,
      sv.user_id,
      sv.hashtags,
      sv.sound_name,
      sv.duration_seconds,
      sv.like_count,
      sv.comment_count,
      sv.share_count,
      sv.view_count,
      sv.created_at,
      GREATEST(0.001, EXTRACT(EPOCH FROM (now() - sv.created_at)) / 3600.0) AS age_hours,
      COALESCE(rv.views, 0) AS my_views,
      COALESCE(rv.avg_completion, 0) AS my_completion,
      COALESCE(rv.avg_watch_ratio, 0) AS my_watch_ratio,
      COALESCE(rv.replayed, false) AS my_replayed,
      COALESCE(gq.avg_completion, 0.5) AS global_completion,
      COALESCE(gq.avg_watch_ratio, 0.5) AS global_watch_ratio,
      COALESCE(gq.samples, 0) AS quality_samples
    FROM public.short_videos sv
    JOIN input_ids i ON i.id = sv.id
    LEFT JOIN recent_views rv ON rv.video_id = sv.id
    LEFT JOIN global_quality gq ON gq.video_id = sv.id
    WHERE sv.is_public = true
  ),
  scored AS (
    SELECT
      b.id AS video_id,
      LEAST(1.0, (b.like_count * 0.25 + b.comment_count * 0.45 + b.share_count * 0.80 + b.view_count * 0.03) / 1000.0)::numeric AS engagement,
      LEAST(1.0, (b.like_count + b.comment_count * 2 + b.share_count * 4)::numeric / (GREATEST(b.age_hours, 0.25) * 45.0))::numeric AS velocity,
      GREATEST(0, POWER(0.5, b.age_hours / 36.0))::numeric AS recency,
      COALESCE((b.global_completion * 0.65 + b.global_watch_ratio * 0.35), 0.5)::numeric AS completion_quality,
      CASE WHEN EXISTS (SELECT 1 FROM following f WHERE f.user_id = b.user_id) THEN 1.0 ELSE 0.0 END::numeric AS following_affinity,
      CASE
        WHEN COALESCE(array_length(b.hashtags, 1), 0) = 0 THEN 0
        ELSE LEAST(1.0, COALESCE((
          SELECT sum(i.weight)::numeric
          FROM unnest(COALESCE(b.hashtags, ARRAY[]::text[])) h
          JOIN interests i ON i.tag = lower(h)
        ), 0) / GREATEST(1, array_length(b.hashtags, 1)))
      END::numeric AS explicit_interest,
      LEAST(1.0, COALESCE((
        SELECT sum(ht.affinity)::numeric
        FROM unnest(COALESCE(b.hashtags, ARRAY[]::text[])) h
        JOIN history_tags ht ON ht.tag = lower(h)
      ), 0) / 8.0)::numeric AS sequence_interest,
      LEAST(1.0, COALESCE((
        SELECT hs.affinity::numeric FROM history_sounds hs
        WHERE b.sound_name IS NOT NULL AND hs.sound_name = lower(b.sound_name)
        LIMIT 1
      ), 0) / 5.0)::numeric AS sound_interest,
      LEAST(1.0, GREATEST(0, 1.0 - COALESCE(b.view_count, 0)::numeric / 1500.0))
        * CASE WHEN b.age_hours < 72 THEN 1 ELSE 0.35 END AS exploration,
      LEAST(0.35, COALESCE(rae.seen_count, 0)::numeric * 0.08) AS author_repeat_penalty,
      LEAST(0.25, COALESCE(rse.seen_count, 0)::numeric * 0.07) AS sound_repeat_penalty,
      CASE
        WHEN b.my_views > 0 AND b.my_completion < 0.25 AND b.my_watch_ratio < 0.25 AND NOT b.my_replayed THEN 0.25
        WHEN b.my_views > 0 AND b.my_completion >= 0.85 THEN -0.08
        WHEN b.my_views > 0 THEN 0.12
        ELSE 0
      END AS seen_penalty
    FROM base b
    LEFT JOIN recent_author_exposure rae ON rae.user_id = b.user_id
    LEFT JOIN recent_sound_exposure rse ON b.sound_name IS NOT NULL AND rse.sound_name = lower(b.sound_name)
  ),
  final AS (
    SELECT
      s.video_id,
      s.engagement,
      s.velocity,
      GREATEST(0.0, LEAST(1.0,
        s.completion_quality * 0.24
        + s.velocity * 0.14
        + s.engagement * 0.12
        + GREATEST(s.explicit_interest, s.sequence_interest) * 0.20
        + s.sound_interest * 0.08
        + s.following_affinity * 0.10
        + s.recency * 0.05
        + s.exploration * 0.07
        - s.author_repeat_penalty
        - s.sound_repeat_penalty
        - s.seen_penalty
        - CASE WHEN v_late_night THEN s.velocity * 0.12 ELSE 0 END
      ))::numeric AS final_score,
      CASE WHEN v_late_night THEN GREATEST(0.0, 1.0 - s.velocity * 0.45) ELSE 1.0 END::numeric AS wellbeing
    FROM scored s
  )
  SELECT
    f.video_id,
    f.final_score AS score,
    f.engagement AS engagement_score,
    f.velocity AS velocity_score,
    f.wellbeing AS wellbeing_score
  FROM final f
  ORDER BY f.final_score DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.video_score_batch(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.video_score_batch(uuid, uuid[]) TO authenticated;

COMMENT ON FUNCTION public.video_score_batch(uuid, uuid[]) IS
  'v6 sequence-aware short-video ranking: completion/watch, recent affinities, sound/author diversity, exploration and wellbeing dampening.';

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
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_effective_user uuid := COALESCE(auth.uid(), p_user_id);
  v_hour int := EXTRACT(HOUR FROM now() AT TIME ZONE 'Europe/Paris');
  v_late_night boolean := false;
BEGIN
  p_limit := GREATEST(1, LEAST(COALESCE(p_limit, 50), 100));
  v_late_night := v_hour >= 0 AND v_hour < 6;

  RETURN QUERY
  WITH following AS (
    SELECT DISTINCT CASE
      WHEN requester_id = v_effective_user THEN addressee_id
      ELSE requester_id
    END AS user_id
    FROM public.friendships
    WHERE v_effective_user IS NOT NULL
      AND status = 'accepted'
      AND (requester_id = v_effective_user OR addressee_id = v_effective_user)
  ),
  interests AS (
    SELECT lower(interest_value) AS tag, GREATEST(0.1, COALESCE(weight, 1))::numeric AS weight
    FROM public.user_interests
    WHERE user_id = v_effective_user
  ),
  history_tags AS (
    SELECT lower(tag) AS tag, sum(LEAST(1.0, GREATEST(0.1, lv.watch_time_seconds::numeric / 600.0))) AS affinity
    FROM public.live_views lv
    JOIN public.live_streams ls ON ls.id = lv.live_id
    CROSS JOIN LATERAL unnest(COALESCE(ls.hashtags, ARRAY[]::text[]) || ARRAY[COALESCE(ls.category, '')]) tag
    WHERE v_effective_user IS NOT NULL
      AND lv.user_id = v_effective_user
      AND lv.joined_at > now() - interval '30 days'
      AND lv.watch_time_seconds >= 30
    GROUP BY lower(tag)
  ),
  recent_host_exposure AS (
    SELECT ls.user_id, count(*) AS seen_count
    FROM public.live_views lv
    JOIN public.live_streams ls ON ls.id = lv.live_id
    WHERE v_effective_user IS NOT NULL
      AND lv.user_id = v_effective_user
      AND lv.joined_at > now() - interval '12 hours'
    GROUP BY ls.user_id
  ),
  active AS (
    SELECT
      ls.id,
      ls.user_id,
      ls.viewer_count,
      ls.peak_viewer_count,
      ls.total_views,
      ls.category,
      ls.hashtags,
      ls.started_at,
      GREATEST(0.001, EXTRACT(EPOCH FROM (now() - COALESCE(ls.started_at, ls.created_at))) / 60.0) AS age_minutes,
      LEAST(1.0, COALESCE((
        SELECT count(*)::numeric / 25.0
        FROM public.live_views lv
        WHERE lv.live_id = ls.id
          AND lv.joined_at > now() - interval '2 minutes'
      ), 0)) AS join_momentum,
      LEAST(1.0, COALESCE((
        SELECT count(*)::numeric / 80.0
        FROM public.live_views lv
        WHERE lv.live_id = ls.id
          AND lv.joined_at > now() - interval '10 minutes'
      ), 0)) AS sustained_momentum,
      LEAST(1.0, ls.viewer_count::numeric / 1200.0) AS viewer_norm
    FROM public.live_streams ls
    WHERE ls.is_active = true
  ),
  scored AS (
    SELECT
      a.id,
      ((a.join_momentum * 0.65) + (a.sustained_momentum * 0.35))::numeric AS momentum_score,
      CASE WHEN EXISTS (SELECT 1 FROM following f WHERE f.user_id = a.user_id) THEN 1.0 ELSE 0.0 END::numeric AS follow_affinity,
      CASE
        WHEN COALESCE(array_length(a.hashtags, 1), 0) = 0 AND COALESCE(a.category, '') = '' THEN 0
        ELSE LEAST(1.0, COALESCE((
          SELECT sum(i.weight)::numeric
          FROM unnest(COALESCE(a.hashtags, ARRAY[]::text[]) || ARRAY[COALESCE(a.category, '')]) h
          JOIN interests i ON i.tag = lower(h)
        ), 0) / GREATEST(1, COALESCE(array_length(a.hashtags, 1), 0) + 1))
      END::numeric AS explicit_interest,
      LEAST(1.0, COALESCE((
        SELECT sum(ht.affinity)::numeric
        FROM unnest(COALESCE(a.hashtags, ARRAY[]::text[]) || ARRAY[COALESCE(a.category, '')]) h
        JOIN history_tags ht ON ht.tag = lower(h)
      ), 0) / 6.0)::numeric AS sequence_interest,
      GREATEST(0.0, LEAST(1.0, 1.0 - (a.age_minutes / 45.0)))::numeric AS freshness_score,
      LEAST(1.0, GREATEST(0.0, 1.0 - a.viewer_norm)) * CASE WHEN a.age_minutes < 90 THEN 1 ELSE 0.35 END AS exploration_score,
      LEAST(0.35, COALESCE(rhe.seen_count, 0)::numeric * 0.09) AS host_repeat_penalty,
      a.viewer_norm
    FROM active a
    LEFT JOIN recent_host_exposure rhe ON rhe.user_id = a.user_id
  ),
  final AS (
    SELECT
      s.id,
      s.momentum_score,
      s.follow_affinity,
      GREATEST(s.explicit_interest, s.sequence_interest)::numeric AS interest_score,
      s.freshness_score,
      GREATEST(0.0, LEAST(1.0,
        s.follow_affinity * 0.22
        + s.momentum_score * 0.24
        + s.viewer_norm * 0.14
        + GREATEST(s.explicit_interest, s.sequence_interest) * 0.20
        + s.freshness_score * 0.10
        + s.exploration_score * 0.10
        - s.host_repeat_penalty
        - CASE WHEN v_late_night THEN s.momentum_score * 0.10 ELSE 0 END
      ))::numeric AS final_score
    FROM scored s
  )
  SELECT
    f.id AS live_id,
    f.final_score AS score,
    f.momentum_score AS momentum,
    f.follow_affinity AS affinity,
    f.interest_score AS interest_match,
    f.freshness_score AS freshness
  FROM final f
  ORDER BY f.final_score DESC
  LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.live_score_batch(uuid, integer) TO authenticated, anon;

COMMENT ON FUNCTION public.live_score_batch(uuid, integer) IS
  'v6 sequence-aware live ranking: live momentum, user history, interest/follow affinity, host diversity, exploration and wellbeing dampening.';
