
DROP FUNCTION IF EXISTS public.get_my_stream_key(uuid);

CREATE OR REPLACE FUNCTION public.get_my_stream_key(p_stream_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT stream_key
  FROM public.live_streams
  WHERE id = p_stream_id
    AND user_id = auth.uid()
  LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_stream_key(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_stream_key(uuid) TO authenticated;
