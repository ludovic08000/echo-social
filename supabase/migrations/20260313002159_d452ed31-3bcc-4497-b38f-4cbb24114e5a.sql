
-- Fix SECURITY DEFINER views by setting them to SECURITY INVOKER
ALTER VIEW public.profiles_safe SET (security_invoker = on);
ALTER VIEW public.public_profiles SET (security_invoker = on);
ALTER VIEW public.anonymous_wall_messages_public SET (security_invoker = on);
ALTER VIEW public.anonymous_wall_messages_safe SET (security_invoker = on);
