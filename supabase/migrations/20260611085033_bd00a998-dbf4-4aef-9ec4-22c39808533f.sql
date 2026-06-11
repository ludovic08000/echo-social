ALTER TABLE public.user_known_fingerprints
ADD COLUMN IF NOT EXISTS verified_manually boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.user_known_fingerprints.verified_manually IS 'True only when the user explicitly verified and trusted the peer safety number.';

CREATE OR REPLACE FUNCTION public.push_my_fingerprint_to_peers()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_my_fp text;
  v_updated integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT fingerprint INTO v_my_fp
  FROM public.user_public_keys
  WHERE user_id = v_user_id AND is_active = true
  LIMIT 1;

  IF v_my_fp IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.user_known_fingerprints
  SET fingerprint = v_my_fp,
      last_seen_at = now(),
      acknowledged = false,
      verified_manually = false
  WHERE peer_user_id = v_user_id
    AND fingerprint != v_my_fp;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;