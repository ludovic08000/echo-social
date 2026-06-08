
-- 1. ai_agents.system_prompt: hide from anon + authenticated, admins via has_role
REVOKE SELECT (system_prompt) ON public.ai_agents FROM anon, authenticated;

-- 2. live_streams.stream_key: hide from anon + authenticated (public reads everything else),
-- owners can read via dedicated policy on a restricted column grant.
REVOKE SELECT (stream_key) ON public.live_streams FROM anon, authenticated;
GRANT SELECT (stream_key) ON public.live_streams TO authenticated;
-- Re-grant but constrained by RLS: add owner-only policy on column via view-style guard.
-- (RLS policies are row-level; column read is allowed only when the row passes RLS AND the
--  caller has column SELECT. We add a strict owner-only SELECT policy duplicated for the key.)
-- Simpler & airtight: revoke from authenticated too, expose owner-only via SECURITY DEFINER fn.
REVOKE SELECT (stream_key) ON public.live_streams FROM authenticated;

CREATE OR REPLACE FUNCTION public.get_my_live_stream_key(_stream_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT stream_key
  FROM public.live_streams
  WHERE id = _stream_id
    AND user_id = auth.uid();
$$;
REVOKE ALL ON FUNCTION public.get_my_live_stream_key(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_live_stream_key(uuid) TO authenticated;

-- 3. profiles.phone_number + date_of_birth: hide from anon entirely
REVOKE SELECT (phone_number, date_of_birth) ON public.profiles FROM anon;

-- 4. sender_key_state.signing_priv_jwk: never readable client-side
REVOKE SELECT (signing_priv_jwk) ON public.sender_key_state FROM anon, authenticated;

-- 5. ml_fraud_signals: drop authenticated insert (admins still manage)
DROP POLICY IF EXISTS "Auth insert fraud signals" ON public.ml_fraud_signals;

-- 6. trust_scores: ensure no self-UPDATE / self-INSERT / self-DELETE policy
DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT polname FROM pg_policy
    WHERE polrelid='public.trust_scores'::regclass
      AND polcmd IN ('w','a','d')
  LOOP
    EXECUTE format('DROP POLICY %I ON public.trust_scores', p.polname);
  END LOOP;
END $$;
-- Admin / service can still mutate (service_role bypasses RLS); add explicit admin manage:
CREATE POLICY "Admins manage trust scores"
  ON public.trust_scores
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

-- 7. ddos_ip_tracker: explicit admin-only SELECT policy
CREATE POLICY "Admins read ddos tracker"
  ON public.ddos_ip_tracker
  FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));
