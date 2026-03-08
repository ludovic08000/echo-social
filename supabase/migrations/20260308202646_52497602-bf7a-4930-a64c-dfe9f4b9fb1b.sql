-- FIX: live_streams - hide stream_key via secure function
CREATE OR REPLACE FUNCTION public.get_safe_live_stream(p_live_id uuid)
RETURNS TABLE(
  id uuid, title text, description text, user_id uuid, is_active boolean,
  viewer_count integer, peak_viewer_count integer, total_views integer,
  category text, hashtags text[], thumbnail_url text, recording_url text,
  started_at timestamptz, ended_at timestamptz, created_at timestamptz,
  stream_key text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT ls.id, ls.title, ls.description, ls.user_id, ls.is_active,
    ls.viewer_count, ls.peak_viewer_count, ls.total_views,
    ls.category, ls.hashtags, ls.thumbnail_url, ls.recording_url,
    ls.started_at, ls.ended_at, ls.created_at,
    CASE WHEN ls.user_id = auth.uid() THEN ls.stream_key ELSE NULL END as stream_key
  FROM live_streams ls WHERE ls.id = p_live_id;
$$;

-- FIX: anonymous_wall_messages - update SELECT policy to not leak author_id to public
-- The table still stores author_id but the SELECT policy already restricted.
-- We need a view that hides it:
CREATE OR REPLACE VIEW public.anonymous_wall_messages_safe AS
SELECT
  id,
  CASE WHEN target_user_id = auth.uid() THEN author_id ELSE NULL END as author_id,
  target_user_id,
  message,
  is_approved,
  created_at
FROM public.anonymous_wall_messages;