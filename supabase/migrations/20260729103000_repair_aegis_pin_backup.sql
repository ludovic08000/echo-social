-- Repair the server-side PIN backup contract used by the deployed Aegis client.
-- Idempotent: safe whether the original May migrations ran fully, partially, or not at all.

CREATE TABLE IF NOT EXISTS public.backup_pin_state (
  user_id uuid NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  salt text NOT NULL,
  pin_wrap_master text NOT NULL,
  kdf_version smallint NOT NULL DEFAULT 1,
  attempts_count integer NOT NULL DEFAULT 0,
  attempts_window_start timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.backup_pin_state
  ADD COLUMN IF NOT EXISTS salt text,
  ADD COLUMN IF NOT EXISTS pin_wrap_master text,
  ADD COLUMN IF NOT EXISTS kdf_version smallint DEFAULT 1,
  ADD COLUMN IF NOT EXISTS attempts_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attempts_window_start timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

UPDATE public.backup_pin_state
SET
  kdf_version = COALESCE(kdf_version, 1),
  attempts_count = COALESCE(attempts_count, 0),
  attempts_window_start = COALESCE(attempts_window_start, now()),
  created_at = COALESCE(created_at, now()),
  updated_at = COALESCE(updated_at, now());

ALTER TABLE public.backup_pin_state
  ALTER COLUMN kdf_version SET DEFAULT 1,
  ALTER COLUMN kdf_version SET NOT NULL,
  ALTER COLUMN attempts_count SET DEFAULT 0,
  ALTER COLUMN attempts_count SET NOT NULL,
  ALTER COLUMN attempts_window_start SET DEFAULT now(),
  ALTER COLUMN attempts_window_start SET NOT NULL,
  ALTER COLUMN created_at SET DEFAULT now(),
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_backup_pin_state_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_backup_pin_state_updated_at ON public.backup_pin_state;
CREATE TRIGGER trg_backup_pin_state_updated_at
  BEFORE UPDATE ON public.backup_pin_state
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_backup_pin_state_updated_at();

ALTER TABLE public.backup_pin_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "User reads own backup pin state" ON public.backup_pin_state;
DROP POLICY IF EXISTS "User upserts own backup pin state" ON public.backup_pin_state;
DROP POLICY IF EXISTS "User updates own backup pin state" ON public.backup_pin_state;
DROP POLICY IF EXISTS "User deletes own backup pin state" ON public.backup_pin_state;

CREATE POLICY "User upserts own backup pin state"
  ON public.backup_pin_state
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "User updates own backup pin state"
  ON public.backup_pin_state
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "User deletes own backup pin state"
  ON public.backup_pin_state
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

REVOKE ALL ON TABLE public.backup_pin_state FROM anon;
REVOKE SELECT ON TABLE public.backup_pin_state FROM authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.backup_pin_state TO authenticated;
GRANT ALL ON TABLE public.backup_pin_state TO service_role;

CREATE OR REPLACE FUNCTION public.try_consume_backup_pin_attempt(
  _user_id uuid,
  _max_attempts integer DEFAULT 10,
  _window_seconds integer DEFAULT 86400,
  _lockout_seconds integer DEFAULT 86400
) RETURNS TABLE (
  allowed boolean,
  attempts_remaining integer,
  locked_until timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.backup_pin_state%ROWTYPE;
  now_ts timestamptz := now();
BEGIN
  IF _user_id IS NULL OR (auth.role() <> 'service_role' AND _user_id <> auth.uid()) THEN
    RETURN QUERY SELECT false, 0, NULL::timestamptz;
    RETURN;
  END IF;

  SELECT * INTO rec
  FROM public.backup_pin_state
  WHERE user_id = _user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, NULL::timestamptz;
    RETURN;
  END IF;

  IF now_ts - rec.attempts_window_start > make_interval(secs => _window_seconds) THEN
    rec.attempts_count := 0;
    rec.attempts_window_start := now_ts;
    rec.locked_until := NULL;
  END IF;

  IF rec.locked_until IS NOT NULL AND rec.locked_until > now_ts THEN
    RETURN QUERY SELECT false, 0, rec.locked_until;
    RETURN;
  END IF;

  IF rec.attempts_count >= _max_attempts THEN
    rec.locked_until := now_ts + make_interval(secs => _lockout_seconds);
    UPDATE public.backup_pin_state
    SET
      attempts_count = rec.attempts_count,
      attempts_window_start = rec.attempts_window_start,
      locked_until = rec.locked_until,
      updated_at = now_ts
    WHERE user_id = _user_id;

    RETURN QUERY SELECT false, 0, rec.locked_until;
    RETURN;
  END IF;

  rec.attempts_count := rec.attempts_count + 1;

  UPDATE public.backup_pin_state
  SET
    attempts_count = rec.attempts_count,
    attempts_window_start = rec.attempts_window_start,
    locked_until = NULL,
    updated_at = now_ts
  WHERE user_id = _user_id;

  RETURN QUERY
  SELECT true, GREATEST(_max_attempts - rec.attempts_count, 0), NULL::timestamptz;
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_backup_pin_attempts(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _user_id IS NULL OR (auth.role() <> 'service_role' AND _user_id <> auth.uid()) THEN
    RAISE EXCEPTION 'backup_pin_owner_mismatch' USING ERRCODE = '42501';
  END IF;

  UPDATE public.backup_pin_state
  SET
    attempts_count = 0,
    attempts_window_start = now(),
    locked_until = NULL,
    updated_at = now()
  WHERE user_id = _user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.has_backup_pin(_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _user_id IS NULL OR _user_id <> auth.uid() THEN false
    ELSE EXISTS (
      SELECT 1
      FROM public.backup_pin_state
      WHERE user_id = _user_id
    )
  END;
$$;

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
    RETURN QUERY
    SELECT false, 0, NULL::timestamptz, NULL::text, NULL::text, 0::smallint;
    RETURN;
  END IF;

  SELECT * INTO gate
  FROM public.try_consume_backup_pin_attempt(_user_id);

  IF NOT gate.allowed THEN
    RETURN QUERY
    SELECT false, gate.attempts_remaining, gate.locked_until, NULL::text, NULL::text, 0::smallint;
    RETURN;
  END IF;

  SELECT * INTO rec
  FROM public.backup_pin_state
  WHERE user_id = _user_id;

  IF NOT FOUND THEN
    RETURN QUERY
    SELECT false, 0, NULL::timestamptz, NULL::text, NULL::text, 0::smallint;
    RETURN;
  END IF;

  RETURN QUERY
  SELECT true, gate.attempts_remaining, gate.locked_until, rec.salt, rec.pin_wrap_master, rec.kdf_version;
END;
$$;

REVOKE ALL ON FUNCTION public.try_consume_backup_pin_attempt(uuid, integer, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_backup_pin_attempts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_backup_pin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_backup_pin_blob(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.try_consume_backup_pin_attempt(uuid, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.reset_backup_pin_attempts(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_backup_pin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_backup_pin_blob(uuid) TO authenticated;

DO $$
BEGIN
  IF to_regclass('public.backup_pin_state') IS NULL
     OR to_regprocedure('public.has_backup_pin(uuid)') IS NULL
     OR to_regprocedure('public.release_backup_pin_blob(uuid)') IS NULL THEN
    RAISE EXCEPTION 'AEGIS_PIN_SCHEMA_REPAIR_FAILED';
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
