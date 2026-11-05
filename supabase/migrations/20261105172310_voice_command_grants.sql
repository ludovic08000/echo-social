BEGIN;
-- Voice-only entitlement: no billing, device or administrator role changes.
CREATE TABLE public.voice_command_grants (
  user_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  reason text NOT NULL DEFAULT 'manual_voice_access' CHECK (length(reason)<=200)
);
ALTER TABLE public.voice_command_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_command_grants FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.voice_command_grants TO authenticated;
GRANT ALL ON public.voice_command_grants TO service_role;
CREATE POLICY "Read own active voice grant" ON public.voice_command_grants FOR SELECT TO authenticated
USING (user_id=(SELECT auth.uid()) AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()));
CREATE FUNCTION public.voice_command_access() RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT auth.uid() IS NOT NULL AND (
   EXISTS(SELECT 1 FROM public.voice_command_grants WHERE user_id=auth.uid() AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at>now()))
   OR EXISTS(SELECT 1 FROM public.creator_subscriptions WHERE user_id=auth.uid() AND status='active'
     AND plan IN ('creator_essential','creator_pro','creator_studio') AND stripe_subscription_id IS NOT NULL
     AND current_period_end>now())
 );
$$;
REVOKE ALL ON FUNCTION public.voice_command_access() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.voice_command_access() TO authenticated;
COMMIT;
