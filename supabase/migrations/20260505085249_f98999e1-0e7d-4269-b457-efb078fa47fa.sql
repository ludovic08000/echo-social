-- Returns all device_ids (current + recently revoked) of the same user that
-- share the same fingerprint. Used by the message reader to look up
-- device_copies addressed to predecessor device_ids of the same physical
-- device (e.g. an iPhone that was re-enrolled after Safari ITP wiped IDB).
CREATE OR REPLACE FUNCTION public.list_predecessor_device_ids(
  p_fingerprints TEXT[]
)
RETURNS TABLE(device_id TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT d.device_id
  FROM public.user_devices d
  WHERE d.user_id = auth.uid()
    AND d.device_fingerprint = ANY(COALESCE(p_fingerprints, ARRAY[]::TEXT[]))
    AND (d.is_active = true OR d.revoked_at > now() - interval '30 days')
  ORDER BY d.device_id;
$$;

REVOKE EXECUTE ON FUNCTION public.list_predecessor_device_ids(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_predecessor_device_ids(TEXT[]) TO authenticated;