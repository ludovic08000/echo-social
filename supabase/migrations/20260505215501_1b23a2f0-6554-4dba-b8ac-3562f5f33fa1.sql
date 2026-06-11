
-- ============================================================
-- 1) cleanup_stale_user_devices
--    Marks devices stale (>30d inactive) and revokes very old (>90d) ones.
-- ============================================================
CREATE OR REPLACE FUNCTION public.cleanup_stale_user_devices()
RETURNS TABLE(device_id text, action text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Mark inactive devices (>30 days no activity) as stale
  RETURN QUERY
  UPDATE public.user_devices d
     SET stale_at = now(),
         updated_at = now()
   WHERE d.user_id = v_user_id
     AND d.is_active = true
     AND d.stale_at IS NULL
     AND d.last_seen_at < now() - interval '30 days'
  RETURNING d.device_id, 'stale'::text;

  -- Revoke very old devices (>90 days no activity)
  RETURN QUERY
  UPDATE public.user_devices d
     SET is_active = false,
         revoked_at = now(),
         revoke_reason = COALESCE(d.revoke_reason, 'auto_inactive_90d'),
         updated_at = now()
   WHERE d.user_id = v_user_id
     AND d.is_active = true
     AND d.last_seen_at < now() - interval '90 days'
  RETURNING d.device_id, 'revoked'::text;
END;
$$;

GRANT EXECUTE ON FUNCTION public.cleanup_stale_user_devices() TO authenticated;

-- ============================================================
-- 2) device_link_requests table + RPCs
--    Approval-based linked-device transfer (Signal-style).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.device_link_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  requester_device_id text NOT NULL,
  requester_label text,
  requester_public_key jsonb NOT NULL,
  approver_device_id text,
  encrypted_payload text,
  status text NOT NULL DEFAULT 'pending', -- pending | approved | claimed | expired
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  claimed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);

CREATE INDEX IF NOT EXISTS idx_device_link_requests_user
  ON public.device_link_requests(user_id, status, expires_at DESC);

ALTER TABLE public.device_link_requests ENABLE ROW LEVEL SECURITY;

-- All access is gated by SECURITY DEFINER RPCs below; deny direct table access.
DROP POLICY IF EXISTS "deny_all_device_link_requests" ON public.device_link_requests;
CREATE POLICY "deny_all_device_link_requests"
  ON public.device_link_requests FOR ALL
  USING (false) WITH CHECK (false);

-- Cleanup helper
CREATE OR REPLACE FUNCTION public.cleanup_expired_device_link_requests()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.device_link_requests
   WHERE expires_at < now() - interval '1 hour';
END;
$$;

-- Create a new link request from the new device
CREATE OR REPLACE FUNCTION public.create_device_link_request(
  p_token_hash text,
  p_requester_device_id text,
  p_requester_public_key jsonb,
  p_requester_label text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_token_hash IS NULL OR length(p_token_hash) < 16 THEN
    RAISE EXCEPTION 'Invalid token hash';
  END IF;
  IF p_requester_device_id IS NULL THEN
    RAISE EXCEPTION 'Missing requester device';
  END IF;
  IF p_requester_public_key IS NULL THEN
    RAISE EXCEPTION 'Missing requester public key';
  END IF;

  -- Cleanup expired entries opportunistically
  DELETE FROM public.device_link_requests
   WHERE user_id = v_user_id AND expires_at < now();

  INSERT INTO public.device_link_requests (
    user_id, token_hash, requester_device_id,
    requester_label, requester_public_key, status
  ) VALUES (
    v_user_id, p_token_hash, p_requester_device_id,
    p_requester_label, p_requester_public_key, 'pending'
  )
  ON CONFLICT (token_hash) DO UPDATE SET
    requester_device_id = EXCLUDED.requester_device_id,
    requester_label = EXCLUDED.requester_label,
    requester_public_key = EXCLUDED.requester_public_key,
    status = 'pending',
    encrypted_payload = NULL,
    approver_device_id = NULL,
    approved_at = NULL,
    claimed_at = NULL,
    created_at = now(),
    expires_at = now() + interval '10 minutes'
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Existing device fetches a request to display for approval
CREATE OR REPLACE FUNCTION public.get_device_link_request_for_approval(
  p_token_hash text
) RETURNS TABLE(
  id uuid,
  requester_device_id text,
  requester_label text,
  requester_public_key jsonb,
  status text,
  expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  SELECT r.id, r.requester_device_id, r.requester_label,
         r.requester_public_key, r.status, r.expires_at
    FROM public.device_link_requests r
   WHERE r.token_hash = p_token_hash
     AND r.user_id = v_user_id
     AND r.status = 'pending'
     AND r.expires_at > now()
   LIMIT 1;
END;
$$;

-- Existing device approves with encrypted payload
CREATE OR REPLACE FUNCTION public.approve_device_link_request(
  p_token_hash text,
  p_approver_device_id text,
  p_encrypted_payload text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_updated int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_encrypted_payload IS NULL OR length(p_encrypted_payload) < 32 THEN
    RAISE EXCEPTION 'Invalid encrypted payload';
  END IF;
  IF length(p_encrypted_payload) > 4_000_000 THEN
    RAISE EXCEPTION 'Payload too large';
  END IF;

  UPDATE public.device_link_requests
     SET encrypted_payload = p_encrypted_payload,
         approver_device_id = p_approver_device_id,
         status = 'approved',
         approved_at = now(),
         expires_at = now() + interval '10 minutes'
   WHERE token_hash = p_token_hash
     AND user_id = v_user_id
     AND status = 'pending'
     AND expires_at > now();

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- New device pulls approved payload
CREATE OR REPLACE FUNCTION public.get_approved_device_link_payload(
  p_token_hash text,
  p_requester_device_id text
) RETURNS TABLE(encrypted_payload text, approver_device_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  SELECT r.encrypted_payload, r.approver_device_id
    FROM public.device_link_requests r
   WHERE r.token_hash = p_token_hash
     AND r.user_id = v_user_id
     AND r.requester_device_id = p_requester_device_id
     AND r.status = 'approved'
     AND r.expires_at > now()
   LIMIT 1;
END;
$$;

-- New device confirms successful claim -> delete record
CREATE OR REPLACE FUNCTION public.complete_device_link_request(
  p_token_hash text,
  p_requester_device_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_deleted int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  DELETE FROM public.device_link_requests
   WHERE token_hash = p_token_hash
     AND user_id = v_user_id
     AND requester_device_id = p_requester_device_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_device_link_request(text, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_device_link_request_for_approval(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_device_link_request(text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_approved_device_link_payload(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_device_link_request(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_device_link_requests() TO authenticated;
