CREATE OR REPLACE FUNCTION public.acknowledge_content_strike(p_strike_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN false; END IF;
  UPDATE public.content_strikes
     SET acknowledged = true, acknowledged_at = now()
   WHERE id = p_strike_id AND user_id = v_uid;
  RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.acknowledge_content_strike(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.acknowledge_all_content_strikes()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_count int;
BEGIN
  IF v_uid IS NULL THEN RETURN 0; END IF;
  WITH upd AS (
    UPDATE public.content_strikes
       SET acknowledged = true, acknowledged_at = now()
     WHERE user_id = v_uid AND COALESCE(acknowledged, false) = false
     RETURNING 1
  )
  SELECT count(*)::int INTO v_count FROM upd;
  RETURN COALESCE(v_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.acknowledge_all_content_strikes() TO authenticated;

-- Ensure column exists (no-op if already present)
ALTER TABLE public.content_strikes
  ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;