-- L5 — Backup PIN (WhatsApp-style E2E backup with HSM-like rate-limited PIN)
-- The server NEVER stores the PIN in any form. It stores only:
--   * a random salt (used to derive a stretching key from the PIN client-side)
--   * the master key wrapped by the PIN-derived key (opaque to server)
--   * the attempt counter + lockout window (rate-limit primitive)

CREATE TABLE public.backup_pin_state (
  user_id uuid NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Random 32-byte salt, base64. Public, used in PBKDF2 / Argon2 stretching.
  salt text NOT NULL,
  -- AES-GCM ciphertext of the user's MasterBackupKey, wrapped with the PIN-derived KEK.
  -- Format: base64(iv || ct || tag). Server cannot read it.
  pin_wrap_master text NOT NULL,
  -- HKDF info parameter actually used (versioned in case we rotate the KDF).
  kdf_version smallint NOT NULL DEFAULT 1,
  -- Rate-limit state.
  attempts_count integer NOT NULL DEFAULT 0,
  attempts_window_start timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.backup_pin_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "User reads own backup pin state"
  ON public.backup_pin_state FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "User upserts own backup pin state"
  ON public.backup_pin_state FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "User updates own backup pin state"
  ON public.backup_pin_state FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "User deletes own backup pin state"
  ON public.backup_pin_state FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Trigger to keep updated_at fresh.
CREATE TRIGGER trg_backup_pin_state_updated_at
  BEFORE UPDATE ON public.backup_pin_state
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Server-side RPC used by the e2e-backup-hsm edge function to atomically
-- check + bump the attempt counter and enforce a hard lockout. Runs as
-- security definer so the edge function (anon JWT) can call it after it
-- has authenticated the caller via Authorization header.
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
  SELECT * INTO rec FROM public.backup_pin_state WHERE user_id = _user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, NULL::timestamptz;
    RETURN;
  END IF;

  -- Reset window if expired.
  IF now_ts - rec.attempts_window_start > make_interval(secs => _window_seconds) THEN
    rec.attempts_count := 0;
    rec.attempts_window_start := now_ts;
    rec.locked_until := NULL;
  END IF;

  -- Hard lockout in effect.
  IF rec.locked_until IS NOT NULL AND rec.locked_until > now_ts THEN
    RETURN QUERY SELECT false, 0, rec.locked_until;
    RETURN;
  END IF;

  IF rec.attempts_count >= _max_attempts THEN
    rec.locked_until := now_ts + make_interval(secs => _lockout_seconds);
    UPDATE public.backup_pin_state
       SET attempts_count = rec.attempts_count,
           attempts_window_start = rec.attempts_window_start,
           locked_until = rec.locked_until,
           updated_at = now_ts
     WHERE user_id = _user_id;
    RETURN QUERY SELECT false, 0, rec.locked_until;
    RETURN;
  END IF;

  rec.attempts_count := rec.attempts_count + 1;
  UPDATE public.backup_pin_state
     SET attempts_count = rec.attempts_count,
         attempts_window_start = rec.attempts_window_start,
         locked_until = NULL,
         updated_at = now_ts
   WHERE user_id = _user_id;

  RETURN QUERY SELECT true, GREATEST(_max_attempts - rec.attempts_count, 0), NULL::timestamptz;
END;
$$;

-- After a successful unwrap on the client, reset the counter.
CREATE OR REPLACE FUNCTION public.reset_backup_pin_attempts(_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.backup_pin_state
     SET attempts_count = 0,
         attempts_window_start = now(),
         locked_until = NULL,
         updated_at = now()
   WHERE user_id = _user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.try_consume_backup_pin_attempt(uuid,integer,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reset_backup_pin_attempts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.try_consume_backup_pin_attempt(uuid,integer,integer,integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reset_backup_pin_attempts(uuid) TO authenticated, service_role;