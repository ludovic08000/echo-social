-- 1. Trigger: when a device upserts with a fingerprint, deactivate any
--    previous active device of the same user that shares the same fingerprint
--    (and is not the current device_id). Stops iOS proliferation at the
--    source — the cascade resolver should only return one match.
CREATE OR REPLACE FUNCTION public.dedupe_devices_by_fingerprint()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.device_fingerprint IS NOT NULL
     AND NEW.is_active = true
     AND NEW.revoked_at IS NULL THEN
    UPDATE public.user_devices
    SET is_active = false,
        revoked_at = now()
    WHERE user_id = NEW.user_id
      AND device_fingerprint = NEW.device_fingerprint
      AND device_id <> NEW.device_id
      AND is_active = true
      AND revoked_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dedupe_devices_by_fingerprint ON public.user_devices;
CREATE TRIGGER trg_dedupe_devices_by_fingerprint
AFTER INSERT OR UPDATE OF device_fingerprint, is_active ON public.user_devices
FOR EACH ROW EXECUTE FUNCTION public.dedupe_devices_by_fingerprint();

-- 2. Restrict resolve_device_id_by_fingerprints last-resort iOS fallback to
--    devices seen in the last 7 days (was 90) — narrower, safer.
CREATE OR REPLACE FUNCTION public.resolve_device_id_by_fingerprints(
  p_fingerprints TEXT[],
  p_platform TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_device_id TEXT;
  v_fp TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RETURN NULL; END IF;

  IF p_fingerprints IS NOT NULL THEN
    FOREACH v_fp IN ARRAY p_fingerprints LOOP
      IF v_fp IS NULL OR length(v_fp) = 0 THEN CONTINUE; END IF;
      SELECT device_id INTO v_device_id
      FROM public.user_devices
      WHERE user_id = auth.uid()
        AND device_fingerprint = v_fp
        AND is_active = true
        AND revoked_at IS NULL
      ORDER BY last_seen_at DESC NULLS LAST
      LIMIT 1;
      IF v_device_id IS NOT NULL THEN RETURN v_device_id; END IF;
    END LOOP;
  END IF;

  IF p_platform = 'ios' THEN
    SELECT device_id INTO v_device_id
    FROM public.user_devices
    WHERE user_id = auth.uid()
      AND platform = 'ios'
      AND is_active = true
      AND revoked_at IS NULL
      AND last_seen_at > now() - interval '7 days'
    ORDER BY last_seen_at DESC NULLS LAST
    LIMIT 1;
    IF v_device_id IS NOT NULL THEN RETURN v_device_id; END IF;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_device_id_by_fingerprints(TEXT[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_device_id_by_fingerprints(TEXT[], TEXT) TO authenticated;

-- 3. Backfill: revoke duplicate active iOS devices RIGHT NOW (keep the most
--    recent per (user_id, device_fingerprint))
WITH keepers AS (
  SELECT DISTINCT ON (user_id, device_fingerprint)
    id
  FROM public.user_devices
  WHERE is_active = true
    AND revoked_at IS NULL
    AND device_fingerprint IS NOT NULL
  ORDER BY user_id, device_fingerprint, last_seen_at DESC NULLS LAST
)
UPDATE public.user_devices
SET is_active = false, revoked_at = now()
WHERE is_active = true
  AND revoked_at IS NULL
  AND device_fingerprint IS NOT NULL
  AND id NOT IN (SELECT id FROM keepers);

-- 4. Also revoke iOS devices not seen in 7 days (they were created by ITP
--    proliferation prior to the fingerprint binding fix).
UPDATE public.user_devices
SET is_active = false, revoked_at = now()
WHERE platform = 'ios'
  AND is_active = true
  AND revoked_at IS NULL
  AND last_seen_at < now() - interval '7 days';