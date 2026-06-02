
DROP POLICY IF EXISTS "Users can only update own trust score" ON public.trust_scores;

DROP POLICY IF EXISTS "ure_read_authenticated" ON public.user_recovery_events;
CREATE POLICY "ure_read_own"
  ON public.user_recovery_events
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE SELECT (system_prompt) ON public.ai_agents FROM anon;
REVOKE SELECT (phone_number) ON public.profiles FROM anon;
REVOKE SELECT (email, phone) ON public.pages FROM anon;
REVOKE SELECT (total_revenue) ON public.seller_profiles FROM anon, authenticated;
REVOKE SELECT (stream_key) ON public.live_streams FROM anon, authenticated;
REVOKE SELECT (author_id) ON public.anonymous_wall_messages FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_my_seller_revenue()
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT total_revenue
  FROM public.seller_profiles
  WHERE user_id = auth.uid()
  LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public.get_my_seller_revenue() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_seller_revenue() TO authenticated;
