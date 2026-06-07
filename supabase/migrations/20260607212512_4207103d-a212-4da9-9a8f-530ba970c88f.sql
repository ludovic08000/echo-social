
-- 1. New function: ensure that every user with at least one eligible active device has a primary.
CREATE OR REPLACE FUNCTION public.ensure_primary_device_exists(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidate record;
  v_stale_cutoff timestamptz := now() - interval '90 days';
BEGIN
  -- Skip if a valid primary already exists.
  IF EXISTS (
    SELECT 1 FROM public.user_devices
    WHERE user_id = p_user_id
      AND is_active = true
      AND is_primary = true
      AND revoked_at IS NULL
  ) THEN
    RETURN;
  END IF;

  -- Pick the most recently seen eligible device.
  SELECT *
    INTO v_candidate
  FROM public.user_devices
  WHERE user_id = p_user_id
    AND is_active = true
    AND revoked_at IS NULL
    AND COALESCE(device_public_key, '') <> ''
    AND (last_seen_at IS NULL OR last_seen_at > v_stale_cutoff)
  ORDER BY last_seen_at DESC NULLS LAST, created_at DESC
  LIMIT 1;

  IF v_candidate.id IS NULL THEN
    RETURN; -- nothing to promote
  END IF;

  UPDATE public.user_devices
     SET is_primary = true,
         updated_at = now()
   WHERE id = v_candidate.id;

  -- Bump signed prekey epoch so peers refetch a fresh bundle.
  UPDATE public.device_signed_prekeys
     SET keys_epoch = greatest(keys_epoch + 1, spk_id + 1)
   WHERE user_id = p_user_id
     AND device_id = v_candidate.device_id
     AND is_active = true;

  -- Auto-resolve any pending repair requests; record an auto_promoted marker.
  UPDATE public.device_primary_repair_requests
     SET resolved_at = now()
   WHERE user_id = p_user_id
     AND resolved_at IS NULL;

  INSERT INTO public.device_primary_repair_requests(user_id, reason, candidate_device_ids, resolved_at)
  VALUES (p_user_id, 'auto_promoted', ARRAY[v_candidate.device_id], now());
END;
$$;

-- 2. Trigger: after any insert/update on user_devices, ensure the user still has a primary.
CREATE OR REPLACE FUNCTION public.trg_ensure_primary_after_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.ensure_primary_device_exists(NEW.user_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ensure_primary_after_device_change ON public.user_devices;
CREATE TRIGGER ensure_primary_after_device_change
AFTER INSERT OR UPDATE OF is_active, is_primary, revoked_at, device_public_key, last_seen_at
ON public.user_devices
FOR EACH ROW
EXECUTE FUNCTION public.trg_ensure_primary_after_change();

-- 3. Backfill: repair every existing account that has no primary but has at least one eligible active device.
DO $$
DECLARE
  v_uid uuid;
BEGIN
  FOR v_uid IN
    SELECT DISTINCT ud.user_id
    FROM public.user_devices ud
    WHERE ud.is_active = true
      AND ud.revoked_at IS NULL
      AND COALESCE(ud.device_public_key, '') <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.user_devices p
        WHERE p.user_id = ud.user_id
          AND p.is_active = true
          AND p.is_primary = true
          AND p.revoked_at IS NULL
      )
  LOOP
    PERFORM public.ensure_primary_device_exists(v_uid);
  END LOOP;
END $$;
