
-- Fix: Replace permissive INSERT policy with a proper one using service_role check
DROP POLICY "Service can insert strikes" ON public.content_strikes;
-- Strikes are inserted by edge functions using service_role key, no RLS policy needed for insert
-- Authenticated users can only SELECT their own strikes (already covered)
