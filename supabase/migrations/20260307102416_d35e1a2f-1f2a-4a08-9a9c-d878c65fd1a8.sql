
-- Fix permissive INSERT policy on security_logs - restrict to authenticated users inserting their own logs
DROP POLICY "System can insert security logs" ON public.security_logs;
CREATE POLICY "Authenticated users can insert own logs" ON public.security_logs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));
