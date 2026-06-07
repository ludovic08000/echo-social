-- Server-side video/live ranking for mobile speed and stable pagination.

CREATE INDEX IF NOT EXISTS idx_video_views_user_recent
  ON public.video_views(user_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_views_user_video_recent
  ON public.video_views(user_id, video_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_likes_user_video
  ON public.video_likes(user_id, video_id);

CREATE INDEX IF NOT EXISTS idx_video_saves_user_video
  ON public.video_saves(user_id, video_id);

CREATE INDEX IF NOT EXISTS idx_video_shares_user_video_recent
  ON public.video_shares(user_id, video_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ml_interactions_user_post_signal_recent
  ON public.ml_interactions(user_id, post_id, signal_type, created_at DESC);

CREATE OR REPLACE FUNCTION public.short_video_feed_batch(
  p_user_id uuid,
  p_limit integer DEFAULT 20,
  p_cursor_score numeric DEFAULT NULL,
  p_cursor_created_at timestamptz DEFAULT NULL,
  p_cursor_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
  v_interests text[];
  v_following uuid[];
  v_result jsonb;
BEGIN
  IF p_user_id IS NOT NULL THEN
    SELECT array_agg(lower(interest_value) ORDER BY weight DESC)
      INTO v_interests
    FROM public.user_interests
    WHERE user_id = p_user_id;

    SELECT array_agg(CASE WHEN requester_id = p_user_id THEN addressee_id ELSE requester_id END)
      INTO v_following
    FROM public.friendships
    WHERE status = 'accepted'
      AND (requester_id = p_user_id OR addressee_id = p_user_id);
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT sv.*
    FROM public.short_videos sv
    WHERE sv.is_public = true
      AND sv.created_at > now() - interval '120 days'
    ORDER BY sv.created_at DESC
    LIMIT LEAST(v_limit * 12, 400)
  ),
  scored AS MATERIALIZED (
    SELECT
      c.*,
      GREATEST(0.0, LEAST(1.0,
          (LEAST(1.0, ln(1 + (
              COALESCE(c.like_count, 0) * 1.0
            + COALESCE(c.comment_count, 0) * 2.2
            + COALESCE(c.share_count, 0) * 3.0
          )) / ln(GREATEST(10, COALESCE(c.view_count, 0) + 10))) * 0.22)
        + (LEAST(1.0, COALESCE(c.share_count, 0)::numeric / GREATEST(3, COALESCE(c.view_count, 1))) * 0.12)
        + (exp(-EXTRACT(EPOCH FROM (now() - c.created_at)) / 3600.0 / 72.0) * 0.10)
        + ((CASE WHEN v_following IS NOT NULL AND c.user_id = ANY(v_following) THEN 1.0 ELSE 0.0 END) * 0.22)
        + ((CASE
            WHEN v_interests IS NULL THEN 0.15
            ELSE LEAST(1.0, (
              SELECT COUNT(*)::numeric
              FROM unnest(COALESCE(c.hashtags, ARRAY[]::text[])) tag
              WHERE lower(tag) = ANY(v_interests)
            ) / GREATEST(1, COALESCE(array_length(c.hashtags, 1), 0)))
          END) * 0.18)
        + ((CASE
            WHEN COALESCE(c.view_count, 0) < 250
             AND (v_following IS NULL OR NOT c.user_id = ANY(v_following))
            THEN 1.0 ELSE 0.0
          END) * 0.05)
        + ((abs(hashtextextended(COALESCE(p_user_id::text, 'anon') || ':' || c.id::text || ':' || current_date::text, 0)) % 10000)::numeric / 10000.0 * 0.04)
        - (COALESCE((
            SELECT CASE
              WHEN avg(vv.completion_rate) >= 0.90 THEN 0.06
              WHEN avg(vv.completion_rate) >= 0.50 THEN 0.12
              ELSE 0.24
            END
            FROM public.video_views vv
            WHERE vv.user_id = p_user_id
              AND vv.video_id = c.id
              AND vv.viewed_at > now() - interval '14 days'
          ), 0.0))
        - (LEAST(0.35, COALESCE((
            SELECT COUNT(*)::numeric * 0.12
            FROM public.ml_interactions mi
            WHERE mi.user_id = p_user_id
              AND mi.post_id = c.id
              AND mi.signal_type IN ('hide', 'report', 'skip_fast')
              AND mi.created_at > now() - interval '30 days'
          ), 0.0)))
        - (LEAST(0.18, GREATEST(0, COALESCE((
            SELECT COUNT(*)::numeric
            FROM public.video_views vv2
            JOIN public.short_videos sv2 ON sv2.id = vv2.video_id
            WHERE vv2.user_id = p_user_id
              AND sv2.user_id = c.user_id
              AND vv2.viewed_at > now() - interval '24 hours'
          ), 0.0) - 2) * 0.06))
      ))::numeric AS server_score
    FROM candidates c
  ),
  page AS MATERIALIZED (
    SELECT *
    FROM scored s
    WHERE p_cursor_score IS NULL
       OR s.server_score < p_cursor_score
       OR (s.server_score = p_cursor_score AND s.created_at < p_cursor_created_at)
       OR (s.server_score = p_cursor_score AND s.created_at = p_cursor_created_at AND s.id < p_cursor_id)
    ORDER BY s.server_score DESC, s.created_at DESC, s.id DESC
    LIMIT v_limit
  )
  SELECT jsonb_build_object(
    'videos',
      COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.server_score DESC, p.created_at DESC, p.id DESC) FROM page p), '[]'::jsonb),
    'profiles',
      COALESCE((
        SELECT jsonb_agg(to_jsonb(pr))
        FROM public.profiles pr
        WHERE pr.user_id IN (SELECT DISTINCT user_id FROM page)
      ), '[]'::jsonb),
    'liked_video_ids',
      COALESCE((
        SELECT jsonb_agg(vl.video_id)
        FROM public.video_likes vl
        WHERE vl.user_id = p_user_id
          AND vl.video_id IN (SELECT id FROM page)
      ), '[]'::jsonb),
    'saved_video_ids',
      COALESCE((
        SELECT jsonb_agg(vs.video_id)
        FROM public.video_saves vs
        WHERE vs.user_id = p_user_id
          AND vs.video_id IN (SELECT id FROM page)
      ), '[]'::jsonb),
    'next_cursor',
      COALESCE((
        SELECT jsonb_build_object(
          'score', p.server_score,
          'created_at', p.created_at,
          'id', p.id
        )
        FROM page p
        ORDER BY p.server_score DESC, p.created_at DESC, p.id DESC
        OFFSET GREATEST(v_limit - 1, 0)
        LIMIT 1
      ), 'null'::jsonb),
    'generated_at', extract(epoch from now())
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.short_video_feed_batch(uuid, integer, numeric, timestamptz, uuid)
  TO authenticated, anon;

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
AS $function$
DECLARE
  v_interests text[];
  v_following uuid[];
  v_wb integer := 50;
  v_hour integer := EXTRACT(HOUR FROM now() AT TIME ZONE 'Europe/Paris');
  v_late_penalty numeric := 0;
BEGIN
  IF p_user_id IS NOT NULL THEN
    SELECT array_agg(lower(interest_value)) INTO v_interests
    FROM public.user_interests
    WHERE user_id = p_user_id;

    SELECT array_agg(CASE WHEN requester_id = p_user_id THEN addressee_id ELSE requester_id END)
    INTO v_following
    FROM public.friendships
    WHERE status = 'accepted'
      AND (requester_id = p_user_id OR addressee_id = p_user_id);

    BEGIN
      SELECT score INTO v_wb FROM public.wellbeing_scores WHERE user_id = p_user_id;
    EXCEPTION WHEN OTHERS THEN
      v_wb := 50;
    END;
  END IF;

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
      LEAST(1.0, COALESCE((
        SELECT COUNT(*)::numeric / 30.0
        FROM public.live_views lv
        WHERE lv.live_id = ls.id
          AND lv.joined_at > now() - interval '1 minute'
      ), 0)) AS recent_join_rate,
      LEAST(1.0, ln(1 + COALESCE(ls.viewer_count, 0)) / ln(1001)) AS viewer_norm
    FROM public.live_streams ls
    WHERE ls.is_active = true
  )
  SELECT
    mc.id AS live_id,
    GREATEST(0.0, LEAST(1.0,
        (CASE WHEN v_following IS NOT NULL AND mc.user_id = ANY(v_following) THEN 1.0 ELSE 0.0 END) * 0.30
      + ((mc.recent_join_rate * 0.6) + (mc.viewer_norm * 0.4)) * 0.30
      + (CASE
           WHEN v_interests IS NOT NULL THEN
             LEAST(1.0, (
               SELECT COUNT(*)::numeric
               FROM unnest(COALESCE(mc.hashtags, ARRAY[]::text[]) || ARRAY[COALESCE(mc.category, '')]) tag
               WHERE lower(tag) = ANY(v_interests)
             ) / GREATEST(1, COALESCE(array_length(mc.hashtags, 1), 0) + 1))
           ELSE 0.2
         END) * 0.20
      + (CASE
           WHEN mc.started_at IS NOT NULL THEN
             GREATEST(0.0, 1.0 - EXTRACT(EPOCH FROM (now() - mc.started_at)) / 1800.0)
           ELSE 0.5
         END) * 0.15
      + ((abs(hashtextextended(COALESCE(p_user_id::text, 'anon') || ':' || mc.id::text || ':' || date_trunc('hour', now())::text, 0)) % 10000)::numeric / 10000.0 * 0.04)
      - (CASE WHEN v_wb < 40 THEN mc.recent_join_rate * v_late_penalty ELSE v_late_penalty * 0.5 END)
    ))::numeric AS score,
    mc.recent_join_rate AS momentum,
    (CASE WHEN v_following IS NOT NULL AND mc.user_id = ANY(v_following) THEN 1.0 ELSE 0.0 END)::numeric AS affinity,
    (CASE
       WHEN v_interests IS NOT NULL THEN
         LEAST(1.0, (
           SELECT COUNT(*)::numeric
           FROM unnest(COALESCE(mc.hashtags, ARRAY[]::text[]) || ARRAY[COALESCE(mc.category, '')]) tag
           WHERE lower(tag) = ANY(v_interests)
         ) / GREATEST(1, COALESCE(array_length(mc.hashtags, 1), 0) + 1))
       ELSE 0.0
     END)::numeric AS interest_match,
    (CASE
       WHEN mc.started_at IS NOT NULL THEN
         GREATEST(0.0, 1.0 - EXTRACT(EPOCH FROM (now() - mc.started_at)) / 1800.0)
       ELSE 0.5
     END)::numeric AS freshness
  FROM momentum_calc mc
  ORDER BY score DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.live_score_batch(uuid, integer)
  TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.live_feed_bundle(
  p_user_id uuid,
  p_active_limit integer DEFAULT 80,
  p_replay_limit integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_active jsonb;
  v_replays jsonb;
  v_profiles jsonb;
  v_ranks jsonb;
  v_following jsonb;
BEGIN
  WITH ranked AS MATERIALIZED (
    SELECT * FROM public.live_score_batch(p_user_id, p_active_limit)
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.server_score DESC), '[]'::jsonb)
    INTO v_active
  FROM (
    SELECT ls.id, ls.title, ls.description, ls.thumbnail_url, ls.is_active,
           ls.viewer_count, ls.peak_viewer_count, ls.total_views, ls.category,
           ls.hashtags, ls.user_id, ls.recording_url, ls.started_at,
           NULL::timestamptz AS ended_at,
           COALESCE(r.score, 0.0) AS server_score
    FROM public.live_streams ls
    LEFT JOIN ranked r ON r.live_id = ls.id
    WHERE ls.is_active = true
    ORDER BY COALESCE(r.score, 0.0) DESC, ls.viewer_count DESC
    LIMIT p_active_limit
  ) t;

  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb)
    INTO v_replays
  FROM (
    SELECT ls.id, ls.title, ls.description, ls.thumbnail_url, ls.is_active,
           ls.viewer_count, ls.peak_viewer_count, ls.total_views, ls.category,
           ls.hashtags, ls.user_id, ls.recording_url, ls.started_at, ls.ended_at
    FROM public.live_streams ls
    WHERE ls.is_active = false
      AND ls.ended_at IS NOT NULL
    ORDER BY ls.ended_at DESC
    LIMIT p_replay_limit
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
      LIMIT 200
    )
  ) p;

  SELECT COALESCE(jsonb_object_agg(live_id, score), '{}'::jsonb)
    INTO v_ranks
  FROM public.live_score_batch(p_user_id, p_active_limit);

  IF p_user_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(CASE WHEN requester_id = p_user_id THEN addressee_id ELSE requester_id END), '[]'::jsonb)
      INTO v_following
    FROM public.friendships
    WHERE status = 'accepted'
      AND (requester_id = p_user_id OR addressee_id = p_user_id);
  ELSE
    v_following := '[]'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'active', v_active,
    'replays', v_replays,
    'profiles', v_profiles,
    'ranks', v_ranks,
    'following', v_following,
    'generated_at', extract(epoch from now())
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.live_feed_bundle(uuid, integer, integer)
  TO authenticated, anon;
