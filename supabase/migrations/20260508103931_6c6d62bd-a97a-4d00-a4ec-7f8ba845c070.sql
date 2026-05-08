-- Drop direct SELECT on the backup PIN state — only the gated RPC may release the wrapped blob.
DROP POLICY IF EXISTS "User reads own backup pin state" ON public.backup_pin_state;

-- Lightweight existence check (no sensitive data).
CREATE OR REPLACE FUNCTION public.has_backup_pin(_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS(SELECT 1 FROM public.backup_pin_state WHERE user_id = _user_id);
$$;

-- Atomic: consume an attempt slot, then return the wrapped blob if allowed.
CREATE OR REPLACE FUNCTION public.release_backup_pin_blob(_user_id uuid)
RETURNS TABLE (
  allowed boolean,
  attempts_remaining integer,
  locked_until timestamptz,
  salt text,
  pin_wrap_master text,
  kdf_version smallint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  gate record;
  rec public.backup_pin_state%ROWTYPE;
BEGIN
  IF _user_id IS NULL OR _user_id <> auth.uid() THEN
    RETURN QUERY SELECT false, 0, NULL::timestamptz, NULL::text, NULL::text, 0::smallint;
    RETURN;
  END IF;

  SELECT * INTO gate FROM public.try_consume_backup_pin_attempt(_user_id);
  IF NOT gate.allowed THEN
    RETURN QUERY SELECT false, gate.attempts_remaining, gate.locked_until, NULL::text, NULL::text, 0::smallint;
    RETURN;
  END IF;

  SELECT * INTO rec FROM public.backup_pin_state WHERE user_id = _user_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, NULL::timestamptz, NULL::text, NULL::text, 0::smallint;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, gate.attempts_remaining, gate.locked_until, rec.salt, rec.pin_wrap_master, rec.kdf_version;
END;
$$;

REVOKE ALL ON FUNCTION public.has_backup_pin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_backup_pin_blob(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_backup_pin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_backup_pin_blob(uuid) TO authenticated;