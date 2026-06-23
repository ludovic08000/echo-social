-- Signal/Sesame bundle contract hardening:
-- A device must not be advertised as an encryption target until its X3DH
-- bundle is complete enough to bootstrap immediately.

CREATE OR REPLACE FUNCTION public.list_active_devices_for_user(p_user_id uuid)
RETURNS TABLE (device_id text, device_public_key text, platform text, last_seen_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH sdl AS (
    SELECT device_ids FROM public.signed_device_lists WHERE user_id = p_user_id
  ),
  sdl_ids AS (
    SELECT unnest(device_ids) AS device_id FROM sdl
  )
  SELECT ud.device_id, ud.device_public_key, ud.platform, ud.last_seen_at
  FROM public.user_devices ud
  WHERE ud.user_id = p_user_id
    AND ud.is_active = true
    AND coalesce(ud.approval_status, 'approved') = 'approved'
    AND ud.revoked_at IS NULL
    AND ud.stale_at IS NULL
    AND ud.device_public_key IS NOT NULL
    AND length(trim(ud.device_public_key)) > 0
    AND EXISTS (
      SELECT 1
      FROM public.device_signed_prekeys dsp
      WHERE dsp.user_id = ud.user_id
        AND dsp.device_id = ud.device_id
        AND dsp.is_active = true
        AND dsp.public_key IS NOT NULL
        AND length(trim(dsp.public_key)) > 0
        AND dsp.signature IS NOT NULL
        AND length(trim(dsp.signature)) > 0
        AND (dsp.expires_at IS NULL OR dsp.expires_at > now())
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.invalid_e2ee_devices bad
      WHERE bad.user_id = ud.user_id AND bad.device_id = ud.device_id
    )
    AND (
      NOT EXISTS (SELECT 1 FROM sdl)
      OR ud.device_id IN (SELECT device_id FROM sdl_ids)
    )
  ORDER BY ud.last_seen_at DESC NULLS LAST;
$$;

GRANT EXECUTE ON FUNCTION public.list_active_devices_for_user(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_device_prekey_bundle(p_user_id uuid, p_device_id text)
RETURNS TABLE (spk_id integer, public_key text, signature text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT dsp.spk_id, dsp.public_key, dsp.signature
  FROM public.device_signed_prekeys dsp
  JOIN public.user_devices ud
    ON ud.user_id = dsp.user_id
   AND ud.device_id = dsp.device_id
  WHERE dsp.user_id = p_user_id
    AND dsp.device_id = p_device_id
    AND dsp.is_active = true
    AND dsp.public_key IS NOT NULL
    AND length(trim(dsp.public_key)) > 0
    AND dsp.signature IS NOT NULL
    AND length(trim(dsp.signature)) > 0
    AND (dsp.expires_at IS NULL OR dsp.expires_at > now())
    AND ud.is_active = true
    AND coalesce(ud.approval_status, 'approved') = 'approved'
    AND ud.revoked_at IS NULL
    AND ud.stale_at IS NULL
    AND ud.device_public_key IS NOT NULL
    AND length(trim(ud.device_public_key)) > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.invalid_e2ee_devices bad
      WHERE bad.user_id = dsp.user_id AND bad.device_id = dsp.device_id
    )
  ORDER BY dsp.created_at DESC NULLS LAST, dsp.spk_id DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_device_prekey_bundle(uuid, text) TO authenticated;

-- Best-effort: existing devices with no active complete device SPK are no longer
-- valid targets until their owner republishes a complete bundle.
UPDATE public.user_devices ud
SET prekey_repair_requested_at = coalesce(ud.prekey_repair_requested_at, now())
WHERE ud.is_active = true
  AND NOT EXISTS (
    SELECT 1
    FROM public.device_signed_prekeys dsp
    WHERE dsp.user_id = ud.user_id
      AND dsp.device_id = ud.device_id
      AND dsp.is_active = true
      AND dsp.public_key IS NOT NULL
      AND length(trim(dsp.public_key)) > 0
      AND dsp.signature IS NOT NULL
      AND length(trim(dsp.signature)) > 0
      AND (dsp.expires_at IS NULL OR dsp.expires_at > now())
  );
