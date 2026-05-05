ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS stale_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS revoke_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_user_devices_lifecycle
  ON public.user_devices (user_id, is_active, revoked_at, last_seen_at DESC);

CREATE OR REPLACE FUNCTION public.guard_user_device_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.is_active = true THEN
    RAISE EXCEPTION 'USER_DEVICES_REACTIVATION_BLOCKED table=user_devices column=is_active value=true constraint=revoked_device_cannot_be_reactivated device_id=%', OLD.device_id
      USING ERRCODE = '23514',
            DETAIL = format('Rejected reactivation of revoked device_id=%s for user_id=%s', OLD.device_id, OLD.user_id),
            HINT = 'Create a fresh device registration instead of reactivating a revoked row.';
  END IF;

  IF NEW.is_active = false AND NEW.revoked_at IS NULL THEN
    NEW.revoked_at := now();
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_user_device_lifecycle ON public.user_devices;
CREATE TRIGGER trg_guard_user_device_lifecycle
  BEFORE UPDATE ON public.user_devices
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_user_device_lifecycle();