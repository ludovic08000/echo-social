-- =========================================================
-- Batch 1: login anti-bruteforce + device-link + Stripe idempotence + privacy IA
-- All changes are additive and backward-compatible.
-- =========================================================

-- ---------------------------------------------------------
-- 1) LOGIN ANTI-BRUTEFORCE
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address text,
  email_hash text,            -- sha256(lower(email)) — never store raw email
  success boolean NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time
  ON public.login_attempts (ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time
  ON public.login_attempts (email_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_attempts_cleanup
  ON public.login_attempts (created_at);

ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;

-- Only service role / SECURITY DEFINER functions read/write this table.
-- No policies => no client access.

-- Server-side rate limit for login attempts.
-- Returns: { allowed bool, retry_after_seconds int, reason text }
-- Strategy: sliding 15-min window
--   - per IP: 20 attempts
--   - per email_hash: 8 attempts
--   - progressive backoff: failures within last 5min add delay
CREATE OR REPLACE FUNCTION public.check_login_rate_limit(
  p_ip text,
  p_email_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ip_failures int := 0;
  v_email_failures int := 0;
  v_recent_email_failures int := 0;
  v_retry int := 0;
BEGIN
  IF p_ip IS NULL AND p_email_hash IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
  END IF;

  IF p_ip IS NOT NULL THEN
    SELECT count(*) INTO v_ip_failures
    FROM public.login_attempts
    WHERE ip_address = p_ip
      AND success = false
      AND created_at > now() - interval '15 minutes';
  END IF;

  IF p_email_hash IS NOT NULL THEN
    SELECT count(*) INTO v_email_failures
    FROM public.login_attempts
    WHERE email_hash = p_email_hash
      AND success = false
      AND created_at > now() - interval '15 minutes';

    SELECT count(*) INTO v_recent_email_failures
    FROM public.login_attempts
    WHERE email_hash = p_email_hash
      AND success = false
      AND created_at > now() - interval '5 minutes';
  END IF;

  -- Hard blocks
  IF v_ip_failures >= 20 THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', 900,
      'reason', 'ip_rate_limit'
    );
  END IF;

  IF v_email_failures >= 8 THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', 900,
      'reason', 'email_rate_limit'
    );
  END IF;

  -- Progressive backoff after 3 recent failures on the same email
  IF v_recent_email_failures >= 3 THEN
    -- 2^(failures-2) seconds, capped at 60s
    v_retry := LEAST(60, power(2, v_recent_email_failures - 2)::int);
    RETURN jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', v_retry,
      'reason', 'backoff'
    );
  END IF;

  RETURN jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_login_attempt(
  p_ip text,
  p_email_hash text,
  p_success boolean,
  p_user_agent text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.login_attempts (ip_address, email_hash, success, user_agent)
  VALUES (p_ip, p_email_hash, p_success, p_user_agent);
$$;

CREATE OR REPLACE FUNCTION public.cleanup_old_login_attempts()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.login_attempts WHERE created_at < now() - interval '7 days';
$$;

-- ---------------------------------------------------------
-- 2) DEVICE-LINK: atomic single-use consumption
-- ---------------------------------------------------------
-- Atomically marks a device-link token as claimed if and only if it is
-- unclaimed and unexpired. Returns the row when consumption succeeds, NULL otherwise.
CREATE OR REPLACE FUNCTION public.consume_device_link_token(p_token_hash text)
RETURNS TABLE (user_id uuid, encrypted_payload text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT id
    FROM public.device_link_tokens
    WHERE token_hash = p_token_hash
      AND claimed_at IS NULL
      AND expires_at > now()
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ),
  claimed AS (
    UPDATE public.device_link_tokens t
    SET claimed_at = now()
    FROM picked p
    WHERE t.id = p.id
    RETURNING t.user_id, t.encrypted_payload
  )
  SELECT c.user_id, c.encrypted_payload FROM claimed c;
END;
$$;

-- ---------------------------------------------------------
-- 3) STRIPE: idempotency + atomic stock decrement
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stripe_processed_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.stripe_processed_events ENABLE ROW LEVEL SECURITY;
-- No policies: only service role / SECURITY DEFINER can touch it.

-- Returns true if this event_id was newly recorded (i.e. should be processed),
-- false if it was already processed (skip).
CREATE OR REPLACE FUNCTION public.stripe_mark_event_processed(
  p_event_id text,
  p_event_type text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.stripe_processed_events (event_id, event_type)
  VALUES (p_event_id, p_event_type)
  ON CONFLICT (event_id) DO NOTHING;
  RETURN FOUND;
END;
$$;

-- Atomic stock decrement: returns true if stock was decremented, false otherwise.
-- NULL stock = unlimited (always succeeds).
CREATE OR REPLACE FUNCTION public.decrement_product_stock(
  p_product_id uuid,
  p_quantity int
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated int;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN false;
  END IF;

  UPDATE public.products
  SET stock_quantity = stock_quantity - p_quantity
  WHERE id = p_product_id
    AND is_active = true
    AND (stock_quantity IS NULL OR stock_quantity >= p_quantity);

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- ---------------------------------------------------------
-- 4) PRIVACY IA: opt-out
-- ---------------------------------------------------------
ALTER TABLE public.privacy_settings
  ADD COLUMN IF NOT EXISTS ai_data_sharing_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.privacy_settings.ai_data_sharing_enabled IS
  'When false, server-side AI calls (moderation suggestions, recommendations) MUST omit user-identifiable signals and truncate content previews.';

-- Helper to read the flag from edge functions / RPCs (bypasses RLS safely).
CREATE OR REPLACE FUNCTION public.get_ai_data_sharing_enabled(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT ai_data_sharing_enabled FROM public.privacy_settings WHERE user_id = p_user_id),
    true
  );
$$;