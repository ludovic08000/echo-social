
CREATE OR REPLACE FUNCTION public.resolve_device_primary_repair_request(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_owner uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  SELECT user_id INTO v_owner
  FROM public.device_primary_repair_requests
  WHERE id = p_id;
  IF v_owner IS NULL THEN
    RETURN false;
  END IF;
  IF v_owner <> v_uid THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE public.device_primary_repair_requests
    SET resolved_at = now()
  WHERE id = p_id AND resolved_at IS NULL;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_device_primary_repair_request(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_device_primary_repair_request(uuid) TO authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE public.device_primary_repair_requests;
ALTER TABLE public.device_primary_repair_requests REPLICA IDENTITY FULL;
