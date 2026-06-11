
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

  -- Get my current active fingerprint
  SELECT fingerprint INTO v_my_fp
  FROM public.user_public_keys
  WHERE user_id = v_user_id AND is_active = true
  LIMIT 1;

  IF v_my_fp IS NULL THEN
    RETURN 0;
  END IF;

  -- Update all peers who have a stale fingerprint for me
  UPDATE public.user_known_fingerprints
  SET fingerprint = v_my_fp,
      last_seen_at = now(),
      acknowledged = false
  WHERE peer_user_id = v_user_id
    AND fingerprint != v_my_fp;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;
