
-- DDoS protection: IP-level throttling with progressive penalties

-- Table to track request counts per IP with sliding windows
CREATE TABLE IF NOT EXISTS public.ddos_ip_tracker (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address text NOT NULL,
  endpoint text NOT NULL DEFAULT 'global',
  request_count integer NOT NULL DEFAULT 1,
  window_start timestamptz NOT NULL DEFAULT now(),
  penalty_level smallint NOT NULL DEFAULT 0,
  blocked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(ip_address, endpoint)
);

-- Index for fast lookups
CREATE INDEX idx_ddos_ip_lookup ON public.ddos_ip_tracker(ip_address, endpoint);
CREATE INDEX idx_ddos_blocked ON public.ddos_ip_tracker(blocked_until) WHERE blocked_until IS NOT NULL;

-- RLS: only service role can access
ALTER TABLE public.ddos_ip_tracker ENABLE ROW LEVEL SECURITY;

-- Function: check and throttle an IP
-- Returns: allowed (bool), penalty_level, blocked_until, retry_after_seconds
CREATE OR REPLACE FUNCTION public.ddos_check_ip(
  p_ip text,
  p_endpoint text DEFAULT 'global',
  p_max_requests integer DEFAULT 120,
  p_window_seconds integer DEFAULT 60
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row ddos_ip_tracker%ROWTYPE;
  v_now timestamptz := now();
  v_window_start timestamptz;
  v_allowed boolean := true;
  v_penalty smallint := 0;
  v_block_duration interval;
  v_blocked_until timestamptz;
  v_retry_after integer := 0;
BEGIN
  -- Check if IP is currently blocked
  SELECT * INTO v_row
  FROM ddos_ip_tracker
  WHERE ip_address = p_ip AND endpoint = p_endpoint
  FOR UPDATE;

  IF v_row IS NOT NULL AND v_row.blocked_until IS NOT NULL AND v_row.blocked_until > v_now THEN
    -- Still blocked
    v_retry_after := EXTRACT(EPOCH FROM (v_row.blocked_until - v_now))::integer;
    RETURN jsonb_build_object(
      'allowed', false,
      'penalty_level', v_row.penalty_level,
      'blocked_until', v_row.blocked_until,
      'retry_after_seconds', v_retry_after
    );
  END IF;

  v_window_start := v_now - (p_window_seconds || ' seconds')::interval;

  IF v_row IS NULL THEN
    -- First request from this IP for this endpoint
    INSERT INTO ddos_ip_tracker (ip_address, endpoint, request_count, window_start)
    VALUES (p_ip, p_endpoint, 1, v_now)
    ON CONFLICT (ip_address, endpoint) DO UPDATE
    SET request_count = 1, window_start = v_now, updated_at = v_now;

    RETURN jsonb_build_object('allowed', true, 'penalty_level', 0, 'blocked_until', null, 'retry_after_seconds', 0);
  END IF;

  -- Reset window if expired
  IF v_row.window_start < v_window_start THEN
    UPDATE ddos_ip_tracker
    SET request_count = 1, window_start = v_now, blocked_until = null, updated_at = v_now
    WHERE id = v_row.id;

    RETURN jsonb_build_object('allowed', true, 'penalty_level', v_row.penalty_level, 'blocked_until', null, 'retry_after_seconds', 0);
  END IF;

  -- Increment counter
  UPDATE ddos_ip_tracker
  SET request_count = request_count + 1, updated_at = v_now
  WHERE id = v_row.id;

  -- Check if over limit
  IF (v_row.request_count + 1) > p_max_requests THEN
    -- Progressive penalty: each violation doubles the block duration
    v_penalty := LEAST(v_row.penalty_level + 1, 6); -- max level 6 = ~64 min block
    v_block_duration := (power(2, v_penalty)::integer || ' minutes')::interval;
    v_blocked_until := v_now + v_block_duration;
    v_retry_after := EXTRACT(EPOCH FROM v_block_duration)::integer;

    UPDATE ddos_ip_tracker
    SET penalty_level = v_penalty, blocked_until = v_blocked_until, updated_at = v_now
    WHERE id = v_row.id;

    -- Auto-ban IP if penalty reaches level 4+ (16 min block)
    IF v_penalty >= 4 THEN
      INSERT INTO banned_ips (ip_address, banned_by, reason, expires_at, is_active)
      VALUES (p_ip, '00000000-0000-0000-0000-000000000000', 'DDoS auto-ban (penalty level ' || v_penalty || ')', v_now + interval '24 hours', true)
      ON CONFLICT DO NOTHING;
    END IF;

    RETURN jsonb_build_object(
      'allowed', false,
      'penalty_level', v_penalty,
      'blocked_until', v_blocked_until,
      'retry_after_seconds', v_retry_after
    );
  END IF;

  RETURN jsonb_build_object('allowed', true, 'penalty_level', v_row.penalty_level, 'blocked_until', null, 'retry_after_seconds', 0);
END;
$$;

-- Cleanup function: remove old entries (run daily via cron)
CREATE OR REPLACE FUNCTION public.ddos_cleanup()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  DELETE FROM ddos_ip_tracker
  WHERE updated_at < now() - interval '24 hours';

  -- Also clean expired IP bans
  UPDATE banned_ips SET is_active = false
  WHERE expires_at IS NOT NULL AND expires_at < now() AND is_active = true;
END;
$$;
