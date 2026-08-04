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
  -- Invariant corrigé : la protection anti-rejeu est fail-close.
  -- Toute situation non vérifiable (pas de session, empreinte invalide,
  -- registre indisponible) refuse la consommation du bundle initial.
  IF v_uid IS NULL THEN
    RETURN FALSE;
  END IF;

  IF p_fingerprint IS NULL OR length(p_fingerprint) < 16 OR length(p_fingerprint) > 256 THEN
    RETURN FALSE;
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
    RETURN FALSE;
  END;
END;
$function$;