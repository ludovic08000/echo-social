-- Per-device One-Time PreKeys (OPK) for X3DH forward secrecy.
-- Each OPK is consumed atomically (deleted on use) so two sessions to the
-- same device in the same window derive DIFFERENT shared secrets.
-- 100% additive: X3DH still works without OPK (degraded FS), but uses one when available.

CREATE TABLE IF NOT EXISTS public.device_one_time_prekeys (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  device_id text NOT NULL,
  opk_id integer NOT NULL,
  public_key text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id, opk_id)
);

CREATE INDEX IF NOT EXISTS idx_device_opk_lookup
  ON public.device_one_time_prekeys (user_id, device_id, created_at);

ALTER TABLE public.device_one_time_prekeys ENABLE ROW LEVEL SECURITY;

-- Owner can manage their own device OPKs (insert in batch, delete leftovers)
CREATE POLICY "Owner manages own device OPK"
  ON public.device_one_time_prekeys
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Atomic claim: returns ONE OPK and deletes it in a single transaction.
-- Returns NULL row if no OPK available (caller falls back to SPK-only X3DH).
CREATE OR REPLACE FUNCTION public.claim_device_one_time_prekey(
  p_user_id uuid,
  p_device_id text
)
RETURNS TABLE (
  opk_id integer,
  public_key text
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH picked AS (
    SELECT o.id, o.opk_id, o.public_key
    FROM public.device_one_time_prekeys o
    WHERE o.user_id = p_user_id
      AND o.device_id = p_device_id
    ORDER BY o.created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  ),
  deleted AS (
    DELETE FROM public.device_one_time_prekeys o
    USING picked p
    WHERE o.id = p.id
    RETURNING p.opk_id, p.public_key
  )
  SELECT opk_id, public_key FROM deleted;
$$;

-- Counter: how many OPKs are still available for this device (caller refills when low).
CREATE OR REPLACE FUNCTION public.count_device_one_time_prekeys(
  p_user_id uuid,
  p_device_id text
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::integer
  FROM public.device_one_time_prekeys
  WHERE user_id = p_user_id
    AND device_id = p_device_id;
$$;