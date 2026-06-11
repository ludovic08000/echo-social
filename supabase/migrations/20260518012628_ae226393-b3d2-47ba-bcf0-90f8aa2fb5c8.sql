-- Lot 4 — TOFU recovery-aware ledger + public recovery markers.

-- 1. Tag identity-change events with a change_type so the UI can show a
--    reassuring "this peer restored their account" copy instead of the
--    generic "safety number changed" MITM warning.
ALTER TABLE public.user_identity_change_events
  ADD COLUMN IF NOT EXISTS change_type text NOT NULL DEFAULT 'identity_rotation';

ALTER TABLE public.user_identity_change_events
  DROP CONSTRAINT IF EXISTS uice_change_type_check;
ALTER TABLE public.user_identity_change_events
  ADD CONSTRAINT uice_change_type_check
  CHECK (change_type IN ('identity_rotation', 'recovery_restore'));

-- 2. Public recovery markers. When a user finishes a successful key restore
--    they publish their new fingerprint here. Peers that observe a
--    fingerprint rotation within the marker's lookback window classify the
--    change as 'recovery_restore' (TOFU recovery-aware).
--    The marker only exposes fingerprint hashes + timestamps; no plaintext.
CREATE TABLE IF NOT EXISTS public.user_recovery_events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  reason text NOT NULL DEFAULT 'manual',
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ure_user_time
  ON public.user_recovery_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ure_user_fp
  ON public.user_recovery_events (user_id, fingerprint);

ALTER TABLE public.user_recovery_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ure_insert_self" ON public.user_recovery_events;
CREATE POLICY "ure_insert_self"
ON public.user_recovery_events
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "ure_read_authenticated" ON public.user_recovery_events;
CREATE POLICY "ure_read_authenticated"
ON public.user_recovery_events
FOR SELECT
TO authenticated
USING (true);

-- 3. Auto-purge markers older than 7 days on every insert (low volume).
CREATE OR REPLACE FUNCTION public.purge_old_recovery_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM public.user_recovery_events
  WHERE occurred_at < now() - interval '7 days';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_purge_old_recovery_events ON public.user_recovery_events;
CREATE TRIGGER trg_purge_old_recovery_events
AFTER INSERT ON public.user_recovery_events
FOR EACH STATEMENT
EXECUTE FUNCTION public.purge_old_recovery_events();