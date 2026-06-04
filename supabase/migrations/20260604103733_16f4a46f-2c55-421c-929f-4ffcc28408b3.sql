CREATE OR REPLACE FUNCTION public.list_active_devices_for_user(p_user_id uuid)
RETURNS TABLE(device_id text, device_public_key text, platform text, last_seen_at timestamp with time zone)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH sdl AS (
    SELECT device_ids
    FROM public.signed_device_lists
    WHERE user_id = p_user_id
  ),
  sdl_ids AS (
    SELECT unnest(device_ids) AS device_id
    FROM sdl
  )
  SELECT ud.device_id, ud.device_public_key, ud.platform, ud.last_seen_at
  FROM public.user_devices ud
  WHERE ud.user_id = p_user_id
    AND ud.is_active = true
    AND ud.revoked_at IS NULL
    AND ud.device_public_key IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.invalid_e2ee_devices bad
      WHERE bad.user_id = ud.user_id
        AND bad.device_id = ud.device_id
    )
    AND (
      NOT EXISTS (SELECT 1 FROM sdl)
      OR ud.device_id IN (SELECT device_id FROM sdl_ids)
    )
  ORDER BY ud.last_seen_at DESC NULLS LAST;
$function$;