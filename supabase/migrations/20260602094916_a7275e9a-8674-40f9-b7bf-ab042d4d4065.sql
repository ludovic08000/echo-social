-- Auto-quarantine ghost E2EE devices (no SPK, no OPK, older than 24h)
CREATE OR REPLACE FUNCTION public.quarantine_ghost_e2ee_devices()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  WITH ghosts AS (
    SELECT ud.user_id, ud.device_id
    FROM public.user_devices ud
    WHERE ud.created_at < now() - interval '24 hours'
      AND ud.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.device_signed_prekeys dsp
                      WHERE dsp.user_id = ud.user_id AND dsp.device_id = ud.device_id)
      AND NOT EXISTS (SELECT 1 FROM public.device_one_time_prekeys opk
                      WHERE opk.user_id = ud.user_id AND opk.device_id = ud.device_id)
      AND NOT EXISTS (SELECT 1 FROM public.invalid_e2ee_devices bad
                      WHERE bad.user_id = ud.user_id AND bad.device_id = ud.device_id)
  ), ins AS (
    INSERT INTO public.invalid_e2ee_devices (user_id, device_id, reason)
    SELECT user_id, device_id, 'ghost_no_prekeys' FROM ghosts
    ON CONFLICT (user_id, device_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;

  -- Soft-revoke at user_devices layer too
  UPDATE public.user_devices ud
  SET revoked_at = now(), crypto_invalid_at = now(), crypto_invalid_reason = 'ghost_no_prekeys'
  WHERE ud.revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM public.invalid_e2ee_devices bad
                WHERE bad.user_id = ud.user_id AND bad.device_id = ud.device_id
                  AND bad.reason = 'ghost_no_prekeys');

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.quarantine_ghost_e2ee_devices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.quarantine_ghost_e2ee_devices() TO service_role;

-- Run once now to flush existing ghosts
SELECT public.quarantine_ghost_e2ee_devices();