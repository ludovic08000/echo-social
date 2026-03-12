
-- Fix: replace overly permissive service insert policy with a proper one
DROP POLICY "Service can insert recommendations" ON public.feed_ai_recommendations;
DROP POLICY "Users can insert own metrics" ON public.feed_performance_metrics;

-- Users can insert their own metrics
CREATE POLICY "Users insert own metrics" ON public.feed_performance_metrics
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Edge functions use service_role key which bypasses RLS, so no extra policy needed for recommendations
