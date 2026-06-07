-- Repair the A1/WhatsApp-style device root after iOS cache/PWA storage loss.
--
-- If a user has no active primary device but the freshly logged-in current
-- device is active and has a public key, promote that current device as the
-- account's primary root. This avoids the bad UX loop:
--   login -> no trusted device -> please reconnect -> login -> same state.
--
-- Security notes:
-- - auth.uid() owns the repair.
-- - A revoked/inactive/current-keyless device is never promoted.
-- - If another active primary exists, nothing is changed.
-- - Stale signatures produced by an old primary are revoked after promotion.

CREATE OR REPLACE FUNCTION public.ensure_current_device_primary(
  p_device_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_has_active_primary boolean := false;
  v_current_active boolean := false;
  v_current_primary boolean := false;
  v_current_pub text := null;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  END IF;

  IF p_device_id IS NULL OR length(trim(p_device_id)) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_ID');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.user_devices d
    WHERE d.user_id = v_user
      AND d.is_active = true
      AND d.revoked_at IS NULL
      AND d.is_primary = true
  )
  INTO v_has_active_primary;

  SELECT
    d.is_active = true AND d.revoked_at IS NULL,
    coalesce(d.is_primary, false),
    d.device_public_key
  INTO v_current_active, v_current_primary, v_current_pub
  FROM public.user_devices d
  WHERE d.user_id = v_user
    AND d.device_id = trim(p_device_id)
  LIMIT 1;

  IF coalesce(v_current_primary, false) = true AND coalesce(v_current_active, false) = true THEN
    RETURN jsonb_build_object('ok', true, 'code', 'PRIMARY_ALREADY_CURRENT', 'device_id', trim(p_device_id));
  END IF;

  IF v_has_active_primary THEN
    RETURN jsonb_build_object('ok', true, 'code', 'PRIMARY_ALREADY_EXISTS', 'device_id', trim(p_device_id));
  END IF;

  IF coalesce(v_current_active, false) <> true THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CURRENT_DEVICE_NOT_ACTIVE', 'device_id', trim(p_device_id));
  END IF;

  IF v_current_pub IS NULL OR length(trim(v_current_pub)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CURRENT_DEVICE_HAS_NO_PUBLIC_KEY', 'device_id', trim(p_device_id));
  END IF;

  -- Clear inactive/stale primary flags first, otherwise the partial unique
  -- index can block promotion when an old primary was deactivated but not
  -- fully revoked.
  UPDATE public.user_devices
  SET is_primary = false
  WHERE user_id = v_user
    AND is_primary = true
    AND device_id <> trim(p_device_id);

  UPDATE public.user_devices
  SET is_primary = true,
      last_seen_at = now()
  WHERE user_id = v_user
    AND device_id = trim(p_device_id)
    AND is_active = true
    AND revoked_at IS NULL;

  UPDATE public.user_device_signatures
  SET revoked_at = now()
  WHERE user_id = v_user
    AND revoked_at IS NULL
    AND primary_device_id <> trim(p_device_id);

  RETURN jsonb_build_object('ok', true, 'code', 'PRIMARY_PROMOTED', 'device_id', trim(p_device_id));
END;
$function$;

REVOKE ALL ON FUNCTION public.ensure_current_device_primary(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ensure_current_device_primary(text) TO authenticated;
