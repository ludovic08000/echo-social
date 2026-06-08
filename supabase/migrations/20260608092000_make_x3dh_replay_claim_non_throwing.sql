-- Keep X3DH replay protection strict without turning transient auth/schema
-- states into noisy REST 400s on the decrypt hot path. A duplicate still
-- returns false; malformed or unauthenticated calls simply do not claim.

CREATE OR REPLACE FUNCTION public.claim_x3dh_initial(p_fingerprint TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_inserted INTEGER := 0;
BEGIN
  IF v_uid IS NULL THEN
    RETURN false;
  END IF;

  IF p_fingerprint IS NULL
     OR length(p_fingerprint) < 16
     OR length(p_fingerprint) > 256
     OR p_fingerprint !~ '^[0-9a-f]+$' THEN
    RETURN false;
  END IF;

  DELETE FROM public.x3dh_replay_ledger
  WHERE user_id = v_uid
    AND expires_at < now();

  INSERT INTO public.x3dh_replay_ledger (user_id, fingerprint)
  VALUES (v_uid, p_fingerprint)
  ON CONFLICT (user_id, fingerprint) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_x3dh_initial(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_x3dh_initial(TEXT) TO authenticated;
