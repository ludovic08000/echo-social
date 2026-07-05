
-- 1) Lock down phone_number: no one reads it via profiles table
REVOKE SELECT (phone_number) ON public.profiles FROM anon, authenticated;

-- Owner-only RPC to fetch own phone number
CREATE OR REPLACE FUNCTION public.get_own_phone_number()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT phone_number
  FROM public.profiles
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_own_phone_number() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_own_phone_number() TO authenticated;

-- 2) Lock down live_streams.stream_key: only owners fetch via existing RPC
REVOKE SELECT (stream_key) ON public.live_streams FROM anon, authenticated;

-- Consolidate duplicate SELECT policies on live_streams
DROP POLICY IF EXISTS "Guests can view live streams" ON public.live_streams;
DROP POLICY IF EXISTS "Users can view live streams" ON public.live_streams;
DROP POLICY IF EXISTS "Lives are viewable by everyone" ON public.live_streams;

CREATE POLICY "Live streams are publicly viewable"
  ON public.live_streams
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Consolidate duplicate DELETE policies on live_streams
DROP POLICY IF EXISTS "Users can delete their lives" ON public.live_streams;
DROP POLICY IF EXISTS "Users can delete their own lives" ON public.live_streams;

CREATE POLICY "Owners can delete their lives"
  ON public.live_streams
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);
