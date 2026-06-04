-- 1. Revoke 3 phantom Windows devices for user 98c32ea4 that have no OPK and are not used
UPDATE public.user_devices
SET revoked_at = now(),
    is_active = false,
    crypto_invalid_at = now(),
    crypto_invalid_reason = 'stale_no_opk_phantom'
WHERE user_id = '98c32ea4-faae-4c87-b8d4-8a0ea9e7be7e'
  AND device_id IN (
    '6c2f1b7271e0864bf155c3818b9f43c9',
    '4282976dedaead5b73eb1f4c5c05f779',
    '31eff50c5486c48b527fe4466e2e8ac1'
  )
  AND revoked_at IS NULL;

-- 2. Broaden ghost quarantine to also catch devices with SPK but no OPK after 48h of inactivity.
CREATE OR REPLACE FUNCTION public.quarantine_ghost_e2ee_devices()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $function$
DECLARE
  v_count integer := 0;
BEGIN
  WITH ghosts AS (
    SELECT ud.user_id, ud.device_id, 'ghost_no_prekeys'::text AS reason
    FROM public.user_devices ud
    WHERE ud.created_at < now() - interval '24 hours'
      AND ud.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.device_signed_prekeys dsp
                      WHERE dsp.user_id = ud.user_id AND dsp.device_id = ud.device_id)
      AND NOT EXISTS (SELECT 1 FROM public.device_one_time_prekeys opk
                      WHERE opk.user_id = ud.user_id AND opk.device_id = ud.device_id)
      AND NOT EXISTS (SELECT 1 FROM public.invalid_e2ee_devices bad
                      WHERE bad.user_id = ud.user_id AND bad.device_id = ud.device_id)

    UNION ALL

    -- New: SPK present but ZERO OPK after 48h of inactivity = X3DH may still
    -- work but the device has clearly stopped checking in. Any per-device
    -- copy targeted at it becomes a dead letter and the recipient (who has
    -- a fresher device_id) sees the message body as raw ciphertext.
    SELECT ud.user_id, ud.device_id, 'stale_no_opk'::text AS reason
    FROM public.user_devices ud
    WHERE ud.revoked_at IS NULL
      AND COALESCE(ud.last_seen_at, ud.created_at) < now() - interval '48 hours'
      AND NOT EXISTS (SELECT 1 FROM public.device_one_time_prekeys opk
                      WHERE opk.user_id = ud.user_id AND opk.device_id = ud.device_id)
      AND NOT EXISTS (SELECT 1 FROM public.invalid_e2ee_devices bad
                      WHERE bad.user_id = ud.user_id AND bad.device_id = ud.device_id)
  ), ins AS (
    INSERT INTO public.invalid_e2ee_devices (user_id, device_id, reason)
    SELECT user_id, device_id, reason FROM ghosts
    ON CONFLICT (user_id, device_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;

  -- Soft-revoke at user_devices layer too
  UPDATE public.user_devices ud
  SET revoked_at = now(),
      is_active = false,
      crypto_invalid_at = now(),
      crypto_invalid_reason = COALESCE(bad.reason, 'ghost_no_prekeys')
  FROM public.invalid_e2ee_devices bad
  WHERE ud.revoked_at IS NULL
    AND bad.user_id = ud.user_id
    AND bad.device_id = ud.device_id
    AND bad.reason IN ('ghost_no_prekeys', 'stale_no_opk');

  RETURN v_count;
END;
$function$;

-- 3. Run it now to flush any other ghost across the platform.
SELECT public.quarantine_ghost_e2ee_devices();