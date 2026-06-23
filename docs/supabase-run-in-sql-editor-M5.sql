-- ============================================================================
-- Security audit fix M5 — gate the password-wrapped Master Key behind a
-- rate-limited release RPC (mirrors the existing PIN-backup design).
--
-- Problem: user_backups.wrapped_master_key (+ master_key_iv) is the Master Key
-- wrapped by PBKDF2(user password). If a client/stolen session can SELECT it
-- directly, a weak password can be brute-forced OFFLINE. The PIN backup already
-- solved this (no direct SELECT; release only via a rate-limited SECURITY
-- DEFINER RPC). This applies the same treatment to the password/recovery blob.
--
-- After this migration:
--   * authenticated/anon can NO LONGER SELECT wrapped_master_key / master_key_iv
--     (nor the rate-limit bookkeeping columns) directly;
--   * the client obtains them only via release_backup_master_key(), which is
--     rate-limited to 20 releases / 24h per (user, backup_type).
-- The non-secret columns (encrypted_blob, iv, salt, version, backup_type, …)
-- remain directly readable so existence checks and restore metadata still work.
-- ============================================================================

-- 1) Rate-limit bookkeeping columns.
ALTER TABLE public.user_backups
  ADD COLUMN IF NOT EXISTS mk_attempts_count smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mk_attempts_window_start timestamptz,
  ADD COLUMN IF NOT EXISTS mk_locked_until timestamptz;

-- 2) Rate-limited release function (runs as table owner, bypassing the column
--    REVOKE below; callers are limited to their own row by auth.uid()).
CREATE OR REPLACE FUNCTION public.release_backup_master_key(_user_id uuid, _backup_type text)
RETURNS TABLE(
  allowed boolean,
  attempts_remaining int,
  locked_until timestamptz,
  wrapped_master_key text,
  master_key_iv text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.user_backups%ROWTYPE;
  _max   int      := 20;
  _window interval := interval '24 hours';
  _lock  interval := interval '24 hours';
BEGIN
  -- Only the owner may release their own blob.
  IF auth.uid() IS NULL OR auth.uid() <> _user_id THEN
    RETURN QUERY SELECT false, 0, NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;

  SELECT * INTO rec FROM public.user_backups
   WHERE user_id = _user_id AND backup_type = _backup_type
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, NULL::timestamptz, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Currently locked out?
  IF rec.mk_locked_until IS NOT NULL AND rec.mk_locked_until > now() THEN
    RETURN QUERY SELECT false, 0, rec.mk_locked_until, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Roll the attempt window.
  IF rec.mk_attempts_window_start IS NULL OR rec.mk_attempts_window_start < now() - _window THEN
    UPDATE public.user_backups
       SET mk_attempts_count = 0, mk_attempts_window_start = now(), mk_locked_until = NULL
     WHERE user_id = _user_id AND backup_type = _backup_type;
    rec.mk_attempts_count := 0;
  END IF;

  -- Over the limit → lock and deny.
  IF rec.mk_attempts_count >= _max THEN
    UPDATE public.user_backups
       SET mk_locked_until = now() + _lock
     WHERE user_id = _user_id AND backup_type = _backup_type;
    RETURN QUERY SELECT false, 0, now() + _lock, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Consume one attempt and release.
  UPDATE public.user_backups
     SET mk_attempts_count = mk_attempts_count + 1
   WHERE user_id = _user_id AND backup_type = _backup_type;

  RETURN QUERY SELECT
    true,
    GREATEST(_max - (rec.mk_attempts_count + 1), 0),
    NULL::timestamptz,
    rec.wrapped_master_key,
    rec.master_key_iv;
END;
$$;

REVOKE ALL ON FUNCTION public.release_backup_master_key(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_backup_master_key(uuid, text) TO authenticated;

-- 3) Remove direct SELECT of the brute-forceable columns. Postgres column
--    privileges require replacing the table-level grant with a column-level one.
REVOKE SELECT ON public.user_backups FROM authenticated, anon;
GRANT SELECT (id, user_id, encrypted_blob, salt, iv, version, backup_type, created_at)
  ON public.user_backups TO authenticated;

-- Verification (optional):
-- SELECT has_column_privilege('authenticated','public.user_backups','wrapped_master_key','SELECT');  -- expect false
-- SELECT has_column_privilege('authenticated','public.user_backups','encrypted_blob','SELECT');       -- expect true
