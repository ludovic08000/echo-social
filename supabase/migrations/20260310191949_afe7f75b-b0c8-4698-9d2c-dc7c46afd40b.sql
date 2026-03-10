CREATE OR REPLACE FUNCTION public.cleanup_old_fingerprints()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.device_fingerprints WHERE last_seen_at < now() - interval '365 days';
END;
$$;