-- Fix security definer view by making it SECURITY INVOKER
DROP VIEW IF EXISTS public.anonymous_wall_messages_safe;
CREATE VIEW public.anonymous_wall_messages_safe
WITH (security_invoker = true)
AS
SELECT
  id,
  CASE WHEN target_user_id = auth.uid() THEN author_id ELSE NULL END as author_id,
  target_user_id,
  message,
  is_approved,
  created_at
FROM public.anonymous_wall_messages;