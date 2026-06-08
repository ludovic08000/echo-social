CREATE OR REPLACE FUNCTION public.claim_x3dh_initial(p_fingerprint text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_inserted INTEGER;
BEGIN
  -- Non-throwing: degrade gracefully to "not replayed" so the client
  -- can fall back to its local IDB guard without surfacing a 400.
  IF v_uid IS NULL THEN
    RETURN TRUE;
  END IF;

  IF p_fingerprint IS NULL OR length(p_fingerprint) < 16 OR length(p_fingerprint) > 256 THEN
    RETURN TRUE;
  END IF;

  BEGIN
    DELETE FROM public.x3dh_replay_ledger
     WHERE user_id = v_uid AND expires_at < now();

    INSERT INTO public.x3dh_replay_ledger (user_id, fingerprint)
    VALUES (v_uid, p_fingerprint)
    ON CONFLICT (user_id, fingerprint) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted = 1;
  EXCEPTION WHEN OTHERS THEN
    -- Server ledger unavailable → let client local guard be authoritative.
    RETURN TRUE;
  END;
END;
$function$;