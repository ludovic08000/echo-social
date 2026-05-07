-- ============================================================
-- L3 — Server-side X3DH replay ledger + last-resort SPK grace
-- ============================================================

CREATE TABLE IF NOT EXISTS public.x3dh_replay_ledger (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  fingerprint TEXT NOT NULL,
  consumed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now() + INTERVAL '7 days',
  CONSTRAINT x3dh_replay_ledger_uniq UNIQUE (user_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_x3dh_replay_expires ON public.x3dh_replay_ledger (expires_at);

ALTER TABLE public.x3dh_replay_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "x3dh_replay_no_direct_access" ON public.x3dh_replay_ledger;
CREATE POLICY "x3dh_replay_no_direct_access"
  ON public.x3dh_replay_ledger
  FOR ALL
  TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.claim_x3dh_initial(p_fingerprint TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_inserted INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'X3DH_REPLAY_AUTH_REQUIRED';
  END IF;

  IF p_fingerprint IS NULL OR length(p_fingerprint) < 16 OR length(p_fingerprint) > 256 THEN
    RAISE EXCEPTION 'X3DH_REPLAY_BAD_FINGERPRINT';
  END IF;

  DELETE FROM public.x3dh_replay_ledger
   WHERE user_id = v_uid AND expires_at < now();

  INSERT INTO public.x3dh_replay_ledger (user_id, fingerprint)
  VALUES (v_uid, p_fingerprint)
  ON CONFLICT (user_id, fingerprint) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_x3dh_initial(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_x3dh_initial(TEXT) TO authenticated;

ALTER TABLE public.user_signed_prekeys
  ADD COLUMN IF NOT EXISTS is_last_resort BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.device_signed_prekeys
  ADD COLUMN IF NOT EXISTS is_last_resort BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_user_spk_last_resort
  ON public.user_signed_prekeys (user_id, is_last_resort)
  WHERE is_last_resort = true;

CREATE INDEX IF NOT EXISTS idx_device_spk_last_resort
  ON public.device_signed_prekeys (user_id, device_id, is_last_resort)
  WHERE is_last_resort = true;

-- New helper (does not alter existing get_signed_prekey signature)
CREATE OR REPLACE FUNCTION public.get_signed_prekey_with_fallback(p_user_id UUID)
RETURNS TABLE (
  spk_id INTEGER,
  public_key TEXT,
  signature TEXT,
  is_last_resort BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT spk_id, public_key, signature, is_last_resort
    FROM public.user_signed_prekeys
   WHERE user_id = p_user_id
     AND (is_active = true OR is_last_resort = true)
     AND expires_at > now()
   ORDER BY is_active DESC, created_at DESC
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_signed_prekey_with_fallback(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_signed_prekey_with_fallback(UUID) TO authenticated;