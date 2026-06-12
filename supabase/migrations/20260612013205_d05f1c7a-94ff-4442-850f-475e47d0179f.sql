
DROP FUNCTION IF EXISTS public.live_score_batch(uuid, integer);

CREATE INDEX IF NOT EXISTS idx_ml_interactions_user_created ON public.ml_interactions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_views_user_viewed ON public.video_views (user_id, viewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_views_user_joined ON public.live_views (user_id, joined_at DESC);
CREATE INDEX IF NOT EXISTS idx_short_videos_public_created ON public.short_videos (created_at DESC) WHERE is_public = true;
CREATE INDEX IF NOT EXISTS idx_short_videos_user ON public.short_videos (user_id);
CREATE INDEX IF NOT EXISTS idx_live_streams_active_created ON public.live_streams (created_at DESC) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_live_streams_user ON public.live_streams (user_id);

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
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_paris_hour int;
  v_late_night boolean;
  v_following_ids uuid[];
  v_interests text[];
  v_viewed_ids uuid[];
  v_recent_authors uuid[];
  v_recent_hashtags text[];
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  p_user_id := v_caller;
  IF p_video_ids IS NULL OR array_length(p_video_ids, 1) IS NULL THEN RETURN; END IF;

  v_paris_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Europe/Paris'))::int;
  v_late_night := v_paris_hour >= 0 AND v_paris_hour < 6;

  SELECT COALESCE(array_agg(DISTINCT CASE WHEN requester_id = p_user_id THEN addressee_id ELSE requester_id END), '{}')
    INTO v_following_ids
  FROM public.friendships
  WHERE status = 'accepted' AND (requester_id = p_user_id OR addressee_id = p_user_id);

  SELECT COALESCE(array_agg(interest_value), '{}') INTO v_interests
  FROM (SELECT interest_value FROM public.user_interests WHERE user_id = p_user_id ORDER BY weight DESC NULLS LAST LIMIT 30) s;

  SELECT COALESCE(array_agg(DISTINCT vv.video_id), '{}') INTO v_viewed_ids
  FROM public.video_views vv
  WHERE vv.user_id = p_user_id AND vv.viewed_at > now() - interval '7 days';

  SELECT COALESCE(array_agg(sv.user_id), '{}') INTO v_recent_authors
  FROM (SELECT vv.video_id FROM public.video_views vv WHERE vv.user_id = p_user_id AND vv.viewed_at > now() - interval '24 hours' ORDER BY vv.viewed_at DESC LIMIT 30) recent
  JOIN public.short_videos sv ON sv.id = recent.video_id;

  SELECT COALESCE(array_agg(DISTINCT tag), '{}') INTO v_recent_hashtags
  FROM (
    SELECT unnest(sv.hashtags) AS tag
    FROM public.ml_interactions mi
    JOIN public.short_videos sv ON sv.id = mi.post_id
    WHERE mi.user_id = p_user_id AND mi.created_at > now() - interval '24 hours'
    ORDER BY mi.created_at DESC LIMIT 20
  ) t;

  RETURN QUERY
  WITH base AS (
    SELECT sv.id, sv.user_id, sv.hashtags, sv.like_count, sv.comment_count, sv.share_count, sv.view_count, sv.created_at,
      GREATEST(0.001, EXTRACT(EPOCH FROM (now() - sv.created_at)) / 3600.0) AS age_hours
    FROM public.short_videos sv
    WHERE sv.id = ANY(p_video_ids) AND sv.is_public = true
  ),
  scored AS (
    SELECT b.id AS video_id,
      LEAST(1.0, (b.like_count * 0.3 + b.comment_count * 0.5 + b.share_count * 0.7 + b.view_count * 0.05) / 1000.0)::numeric AS eng,
      LEAST(1.0, (b.like_count + b.comment_count * 2 + b.share_count * 3)::numeric / (b.age_hours * 50.0))::numeric AS vel,
      GREATEST(0, 1.0 - (b.age_hours / 168.0))::numeric AS rec,
      CASE WHEN b.user_id = ANY(v_following_ids) THEN 0.25 ELSE 0 END::numeric AS foll,
      CASE WHEN b.hashtags IS NULL OR array_length(b.hashtags, 1) IS NULL THEN 0
        ELSE LEAST(1.0, (SELECT COUNT(*)::numeric FROM unnest(b.hashtags) h WHERE lower(h) = ANY(SELECT lower(i) FROM unnest(v_interests) i)) / GREATEST(1, array_length(b.hashtags, 1)))
      END::numeric AS interest,
      CASE WHEN b.id = ANY(v_viewed_ids) THEN -0.15 ELSE 0 END::numeric AS view_pen,
      CASE WHEN b.age_hours < 6 THEN 0.10 ELSE 0 END::numeric AS fresh,
      CASE WHEN v_recent_authors IS NULL OR array_length(v_recent_authors, 1) IS NULL THEN 0
        ELSE -LEAST(0.20, (SELECT COUNT(*)::numeric FROM unnest(v_recent_authors) a WHERE a = b.user_id) * 0.05)
      END::numeric AS seq_author_pen,
      CASE WHEN b.hashtags IS NULL OR array_length(b.hashtags, 1) IS NULL OR v_recent_hashtags IS NULL OR array_length(v_recent_hashtags, 1) IS NULL THEN 0
        ELSE LEAST(0.15, (SELECT COUNT(*)::numeric FROM unnest(b.hashtags) h WHERE lower(h) = ANY(SELECT lower(t) FROM unnest(v_recent_hashtags) t)) * 0.05)
      END::numeric AS seq_topic_boost
    FROM base b
  )
  SELECT s.video_id,
    LEAST(1.0, GREATEST(0,
      s.eng * 0.28 + s.vel * 0.13 + s.rec * 0.09 + s.foll + s.interest * 0.18
      + s.view_pen + s.fresh + s.seq_author_pen + s.seq_topic_boost
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
COMMENT ON FUNCTION public.video_score_batch(uuid, uuid[]) IS
  'RecSys v6: sequence-aware short_videos ranking (recent-author dampener + recent-topic continuity, wellbeing late-night dampener).';

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
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_paris_hour int;
  v_late_night boolean;
  v_following_ids uuid[];
  v_interests text[];
  v_recent_authors uuid[];
  v_recent_categories text[];
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  p_user_id := v_caller;
  p_limit := COALESCE(NULLIF(p_limit, 0), 30);
  IF p_limit < 1 THEN p_limit := 1; END IF;
  IF p_limit > 200 THEN p_limit := 200; END IF;

  v_paris_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Europe/Paris'))::int;
  v_late_night := v_paris_hour >= 0 AND v_paris_hour < 6;

  SELECT COALESCE(array_agg(DISTINCT CASE WHEN requester_id = p_user_id THEN addressee_id ELSE requester_id END), '{}')
    INTO v_following_ids
  FROM public.friendships
  WHERE status = 'accepted' AND (requester_id = p_user_id OR addressee_id = p_user_id);

  SELECT COALESCE(array_agg(interest_value), '{}') INTO v_interests
  FROM (SELECT interest_value FROM public.user_interests WHERE user_id = p_user_id ORDER BY weight DESC NULLS LAST LIMIT 30) s;

  SELECT COALESCE(array_agg(ls.user_id), '{}') INTO v_recent_authors
  FROM (SELECT lv.live_id FROM public.live_views lv WHERE lv.user_id = p_user_id AND lv.joined_at > now() - interval '24 hours' ORDER BY lv.joined_at DESC LIMIT 20) recent
  JOIN public.live_streams ls ON ls.id = recent.live_id;

  SELECT COALESCE(array_agg(DISTINCT ls.category), '{}') INTO v_recent_categories
  FROM (SELECT lv.live_id FROM public.live_views lv WHERE lv.user_id = p_user_id AND lv.joined_at > now() - interval '24 hours' ORDER BY lv.joined_at DESC LIMIT 20) recent
  JOIN public.live_streams ls ON ls.id = recent.live_id
  WHERE ls.category IS NOT NULL;

  RETURN QUERY
  WITH base AS (
    SELECT ls.id, ls.user_id, ls.category, ls.hashtags, ls.viewer_count, ls.peak_viewer_count, ls.total_views,
      ls.is_active, ls.started_at, ls.created_at,
      GREATEST(0.001, EXTRACT(EPOCH FROM (now() - COALESCE(ls.started_at, ls.created_at))) / 3600.0) AS age_hours
    FROM public.live_streams ls
    WHERE ls.is_active = true
  ),
  scored AS (
    SELECT b.id AS live_id,
      LEAST(1.0, (b.viewer_count * 0.6 + b.peak_viewer_count * 0.2 + b.total_views * 0.02) / 500.0)::numeric AS eng,
      GREATEST(0, 1.0 - (b.age_hours / 6.0))::numeric AS fresh,
      CASE WHEN b.user_id = ANY(v_following_ids) THEN 0.30 ELSE 0 END::numeric AS foll,
      CASE WHEN b.hashtags IS NULL OR array_length(b.hashtags, 1) IS NULL THEN 0
        ELSE LEAST(1.0, (SELECT COUNT(*)::numeric FROM unnest(b.hashtags) h WHERE lower(h) = ANY(SELECT lower(i) FROM unnest(v_interests) i)) / GREATEST(1, array_length(b.hashtags, 1)))
      END::numeric AS interest,
      CASE WHEN v_recent_authors IS NULL OR array_length(v_recent_authors, 1) IS NULL THEN 0
        ELSE -LEAST(0.20, (SELECT COUNT(*)::numeric FROM unnest(v_recent_authors) a WHERE a = b.user_id) * 0.07)
      END::numeric AS seq_author_pen,
      CASE WHEN b.category IS NULL OR v_recent_categories IS NULL OR array_length(v_recent_categories, 1) IS NULL THEN 0
        WHEN lower(b.category) = ANY(SELECT lower(c) FROM unnest(v_recent_categories) c) THEN 0.12
        ELSE 0
      END::numeric AS seq_cat_boost
    FROM base b
  )
  SELECT s.live_id,
    LEAST(1.0, GREATEST(0,
      s.eng * 0.35 + s.fresh * 0.20 + s.foll + s.interest * 0.20
      + s.seq_author_pen + s.seq_cat_boost
      - CASE WHEN v_late_night THEN s.eng * 0.15 ELSE 0 END
    ))::numeric AS score,
    s.eng AS engagement_score,
    s.fresh AS freshness_score,
    CASE WHEN v_late_night THEN GREATEST(0, 1.0 - s.eng * 0.5) ELSE 1.0 END::numeric AS wellbeing_score
  FROM scored s
  ORDER BY score DESC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.live_score_batch(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.live_score_batch(uuid, integer) TO authenticated;
COMMENT ON FUNCTION public.live_score_batch(uuid, integer) IS
  'RecSys v6: sequence-aware live_streams ranking (recent-author dampener + recent-category continuity, freshness, wellbeing late-night dampener).';
