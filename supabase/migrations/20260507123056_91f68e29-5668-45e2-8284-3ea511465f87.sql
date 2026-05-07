-- ── Server crypto state table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_crypto_state (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  key_slot_id uuid NOT NULL DEFAULT gen_random_uuid(),
  identity_epoch integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'needs_client_key'
    CHECK (status IN ('needs_client_key','ready','error')),
  fingerprint text,
  client_key_published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_crypto_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_crypto_state_select_own" ON public.user_crypto_state;
CREATE POLICY "user_crypto_state_select_own"
  ON public.user_crypto_state FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_crypto_state_insert_own" ON public.user_crypto_state;
CREATE POLICY "user_crypto_state_insert_own"
  ON public.user_crypto_state FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "user_crypto_state_update_own" ON public.user_crypto_state;
CREATE POLICY "user_crypto_state_update_own"
  ON public.user_crypto_state FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS trg_user_crypto_state_updated_at ON public.user_crypto_state;
CREATE TRIGGER trg_user_crypto_state_updated_at
  BEFORE UPDATE ON public.user_crypto_state
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── RPC: ensure_user_crypto_state ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ensure_user_crypto_state()
RETURNS public.user_crypto_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.user_crypto_state;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  INSERT INTO public.user_crypto_state (user_id)
  VALUES (v_uid)
  ON CONFLICT (user_id) DO UPDATE
    SET updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_user_crypto_state() TO authenticated;

-- ── RPC: mark_user_crypto_ready ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_user_crypto_ready(p_fingerprint text)
RETURNS public.user_crypto_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.user_crypto_state;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  INSERT INTO public.user_crypto_state (user_id, status, fingerprint, client_key_published_at)
  VALUES (v_uid, 'ready', p_fingerprint, now())
  ON CONFLICT (user_id) DO UPDATE
    SET status = 'ready',
        fingerprint = EXCLUDED.fingerprint,
        client_key_published_at = COALESCE(public.user_crypto_state.client_key_published_at, now()),
        updated_at = now()
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_user_crypto_ready(text) TO authenticated;