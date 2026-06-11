-- Multi-fingerprint cascade resolver: tries strict → loose → loosest signatures.
-- Last resort on iOS: returns the most recent active iOS device of the user
-- (because Safari ITP can change the fingerprint inputs across sessions).
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
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  -- Try each candidate fingerprint in order (most strict first)
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
      IF v_device_id IS NOT NULL THEN
        RETURN v_device_id;
      END IF;
    END LOOP;
  END IF;

  -- iOS fallback: Safari ITP can rotate UA/screen inputs, so reuse the most
  -- recent active iOS device of the same user when no fingerprint matches.
  IF p_platform = 'ios' THEN
    SELECT device_id INTO v_device_id
    FROM public.user_devices
    WHERE user_id = auth.uid()
      AND platform = 'ios'
      AND is_active = true
      AND revoked_at IS NULL
      AND last_seen_at > now() - interval '90 days'
    ORDER BY last_seen_at DESC NULLS LAST
    LIMIT 1;
    IF v_device_id IS NOT NULL THEN
      RETURN v_device_id;
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_device_id_by_fingerprints(TEXT[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_device_id_by_fingerprints(TEXT[], TEXT) TO authenticated;