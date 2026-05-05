DROP TRIGGER IF EXISTS trg_notify_new_device ON public.user_devices;

CREATE OR REPLACE FUNCTION public.notify_new_device()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Commercial UX: device continuity is handled silently by user_devices,
  -- encrypted backups and the device fingerprint resolver. We intentionally do
  -- not create a visible "verify device" notification on normal login.
  RETURN NEW;
END;
$$;