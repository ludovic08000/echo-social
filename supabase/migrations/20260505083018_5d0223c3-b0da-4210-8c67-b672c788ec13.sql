ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS device_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_user_devices_user_fingerprint
  ON public.user_devices(user_id, device_fingerprint)
  WHERE device_fingerprint IS NOT NULL AND is_active = true;

CREATE OR REPLACE FUNCTION public.resolve_device_id_by_fingerprint(p_fingerprint TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT device_id
  FROM public.user_devices
  WHERE user_id = auth.uid()
    AND device_fingerprint = p_fingerprint
    AND is_active = true
    AND revoked_at IS NULL
  ORDER BY last_seen_at DESC NULLS LAST
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_device_id_by_fingerprint(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_device_id_by_fingerprint(TEXT) TO authenticated;