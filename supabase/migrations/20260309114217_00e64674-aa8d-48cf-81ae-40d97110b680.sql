
-- Fix anonymous_wall_messages: hide author_id
CREATE OR REPLACE VIEW public.anonymous_wall_messages_public AS
SELECT id, target_user_id, message, is_approved, created_at,
  CASE WHEN author_id = auth.uid() THEN author_id ELSE NULL END as author_id
FROM public.anonymous_wall_messages
WHERE is_approved = true;

-- Fix rate_limits: restrict to service role for writes
DROP POLICY IF EXISTS "System can manage rate limits" ON public.rate_limits;
CREATE POLICY "Users can read own rate limits" ON public.rate_limits
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Fix feed_score_cache: restrict to own rows
DROP POLICY IF EXISTS "System can manage feed scores" ON public.feed_score_cache;
CREATE POLICY "Users can read own feed scores" ON public.feed_score_cache
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own feed scores" ON public.feed_score_cache
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own feed scores" ON public.feed_score_cache
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
