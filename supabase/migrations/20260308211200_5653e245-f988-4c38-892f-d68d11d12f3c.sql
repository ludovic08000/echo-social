
-- Point 19: Auto-purge device fingerprints older than 90 days
CREATE OR REPLACE FUNCTION public.cleanup_old_fingerprints()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.device_fingerprints WHERE last_seen_at < now() - interval '90 days';
END;
$$;

-- Point 22: Ensure tip amount has server-side bounds (validation trigger)
CREATE OR REPLACE FUNCTION public.validate_tip_amount()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.amount IS NULL OR NEW.amount < 1 OR NEW.amount > 500 THEN
    RAISE EXCEPTION 'Invalid tip amount: must be between 1 and 500';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER validate_tip_before_insert
BEFORE INSERT ON public.tips
FOR EACH ROW EXECUTE FUNCTION public.validate_tip_amount();
