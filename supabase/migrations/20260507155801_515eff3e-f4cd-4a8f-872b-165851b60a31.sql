
CREATE OR REPLACE FUNCTION public.live_feed_bundle(
  p_user_id uuid,
  p_active_limit integer DEFAULT 80,
  p_replay_limit integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_active jsonb;
  v_replays jsonb;
  v_profiles jsonb;
  v_ranks jsonb;
  v_following jsonb;
BEGIN
  -- Active lives (already ranked server-side)
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_active
  FROM (
    SELECT ls.id, ls.title, ls.description, ls.thumbnail_url, ls.is_active,
           ls.viewer_count, ls.total_views, ls.category, ls.hashtags,
           ls.user_id, ls.recording_url, ls.started_at,
           NULL::timestamptz AS ended_at
    FROM live_streams ls
    WHERE ls.is_active = true
    ORDER BY ls.viewer_count DESC
    LIMIT p_active_limit
  ) t;

  -- Replays (cheap, can be cached aggressively client-side)
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) INTO v_replays
  FROM (
    SELECT ls.id, ls.title, ls.description, ls.thumbnail_url, ls.is_active,
           ls.viewer_count, ls.total_views, ls.category, ls.hashtags,
           ls.user_id, ls.recording_url, ls.started_at, ls.ended_at
    FROM live_streams ls
    WHERE ls.is_active = false
      AND ls.ended_at IS NOT NULL
    ORDER BY ls.ended_at DESC
    LIMIT p_replay_limit
  ) t;

  -- Hosts (single profiles fetch covering both sets)
  SELECT COALESCE(jsonb_agg(row_to_json(p)), '[]'::jsonb) INTO v_profiles
  FROM (
    SELECT pr.user_id, pr.name, pr.avatar_url
    FROM profiles pr
    WHERE pr.user_id IN (
      SELECT DISTINCT ls.user_id FROM live_streams ls
      WHERE (ls.is_active = true)
         OR (ls.is_active = false AND ls.ended_at IS NOT NULL
             AND ls.ended_at > now() - interval '90 days')
      ORDER BY 1
      LIMIT 200
    )
  ) p;

  -- Neural ranks for actives only (wellbeing-aware)
  BEGIN
    SELECT COALESCE(jsonb_object_agg(live_id, score), '{}'::jsonb) INTO v_ranks
    FROM public.live_score_batch(p_user_id, p_active_limit);
  EXCEPTION WHEN OTHERS THEN
    v_ranks := '{}'::jsonb;
  END;

  -- Follow graph (only for authed users)
  IF p_user_id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(
      CASE WHEN requester_id = p_user_id THEN addressee_id ELSE requester_id END
    ), '[]'::jsonb) INTO v_following
    FROM friendships
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
$$;

GRANT EXECUTE ON FUNCTION public.live_feed_bundle(uuid, integer, integer) TO authenticated, anon;
