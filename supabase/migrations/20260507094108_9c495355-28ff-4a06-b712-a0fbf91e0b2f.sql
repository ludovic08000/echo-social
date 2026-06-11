-- Persistent rate-limit RPC used by Edge Functions (_shared/rate-limit.ts)
-- Sliding window backed by a small table. Fail-open is handled by callers.

CREATE TABLE IF NOT EXISTS public.edge_rate_limits (
  key TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key)
);

ALTER TABLE public.edge_rate_limits ENABLE ROW LEVEL SECURITY;

-- Only service role (used inside edge functions) may read/write. No client policies on purpose.
DROP POLICY IF EXISTS "service_role_only" ON public.edge_rate_limits;
CREATE POLICY "service_role_only"
  ON public.edge_rate_limits
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_edge_rate_limits_window
  ON public.edge_rate_limits (window_start);

-- Sliding-window counter. Returns true if the call is allowed, false if it must be throttled.
CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key TEXT,
  p_max_requests INTEGER,
  p_window_seconds INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_threshold TIMESTAMPTZ := v_now - make_interval(secs => p_window_seconds);
  v_count INTEGER;
BEGIN
  -- Reset window if expired, then bump counter atomically.
  INSERT INTO public.edge_rate_limits (key, window_start, count)
  VALUES (p_key, v_now, 1)
  ON CONFLICT (key) DO UPDATE
  SET
    window_start = CASE
      WHEN public.edge_rate_limits.window_start < v_threshold THEN v_now
      ELSE public.edge_rate_limits.window_start
    END,
    count = CASE
      WHEN public.edge_rate_limits.window_start < v_threshold THEN 1
      ELSE public.edge_rate_limits.count + 1
    END
  RETURNING count INTO v_count;

  RETURN v_count <= p_max_requests;
EXCEPTION WHEN OTHERS THEN
  -- Fail open: never block legitimate users on infra error
  RETURN TRUE;
END;
$$;

-- Periodic cleanup helper (callable from a cron if desired)
CREATE OR REPLACE FUNCTION public.cleanup_edge_rate_limits()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.edge_rate_limits
  WHERE window_start < now() - interval '1 hour';
$$;

REVOKE ALL ON FUNCTION public.check_rate_limit(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(TEXT, INTEGER, INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.cleanup_edge_rate_limits() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_edge_rate_limits() TO service_role;