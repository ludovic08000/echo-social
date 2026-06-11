-- Linked-device approval flow.
--
-- A new device creates a short-lived request with an ephemeral P-256 public key.
-- An already-connected device approves that request and uploads an encrypted
-- initial key/history transfer. The server stores only hashes, public keys and
-- ciphertext; it never sees the transferred E2EE material in clear.

CREATE TABLE IF NOT EXISTS public.device_link_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  requester_device_id text NOT NULL,
  requester_public_key jsonb NOT NULL,
  requester_label text,
  approver_device_id text,
  encrypted_payload text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'claimed')),
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + interval '10 minutes'),
  approved_at timestamp with time zone,
  claimed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_link_requests_token_hash
  ON public.device_link_requests (token_hash);

CREATE INDEX IF NOT EXISTS idx_device_link_requests_user_status
  ON public.device_link_requests (user_id, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_link_requests_expires
  ON public.device_link_requests (expires_at);

ALTER TABLE public.device_link_requests ENABLE ROW LEVEL SECURITY;

-- No direct table policies: access goes through token-bound SECURITY DEFINER RPCs.
REVOKE ALL ON public.device_link_requests FROM anon;
REVOKE ALL ON public.device_link_requests FROM authenticated;

CREATE OR REPLACE FUNCTION public.cleanup_expired_device_link_requests()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted integer := 0;
BEGIN
  DELETE FROM public.device_link_requests
  WHERE expires_at < now()
     OR (status = 'claimed' AND claimed_at < now() - interval '1 day');

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.cleanup_expired_device_link_requests()
  TO authenticated;

CREATE OR REPLACE FUNCTION public.create_device_link_request(
  p_token_hash text,
  p_requester_device_id text,
  p_requester_public_key jsonb,
  p_requester_label text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_token_hash IS NULL OR length(trim(p_token_hash)) < 32 THEN
    RAISE EXCEPTION 'Invalid link token';
  END IF;

  IF p_requester_device_id IS NULL OR length(trim(p_requester_device_id)) < 8 THEN
    RAISE EXCEPTION 'Invalid requester device';
  END IF;

  IF p_requester_public_key IS NULL
     OR jsonb_typeof(p_requester_public_key) <> 'object'
     OR p_requester_public_key->>'kty' <> 'EC'
     OR p_requester_public_key->>'crv' <> 'P-256'
     OR length(coalesce(p_requester_public_key->>'x', '')) = 0
     OR length(coalesce(p_requester_public_key->>'y', '')) = 0 THEN
    RAISE EXCEPTION 'Invalid requester public key';
  END IF;

  PERFORM public.cleanup_expired_device_link_requests();

  DELETE FROM public.device_link_requests
  WHERE user_id = v_user
    AND requester_device_id = p_requester_device_id
    AND status = 'pending';

  INSERT INTO public.device_link_requests (
    user_id,
    token_hash,
    requester_device_id,
    requester_public_key,
    requester_label,
    expires_at
  )
  VALUES (
    v_user,
    trim(p_token_hash),
    trim(p_requester_device_id),
    p_requester_public_key,
    left(nullif(trim(coalesce(p_requester_label, '')), ''), 120),
    now() + interval '10 minutes'
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_device_link_request(text, text, jsonb, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.get_device_link_request_for_approval(
  p_token_hash text
)
RETURNS TABLE (
  request_id uuid,
  requester_device_id text,
  requester_public_key jsonb,
  requester_label text,
  created_at timestamp with time zone,
  expires_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  RETURN QUERY
  SELECT
    r.id,
    r.requester_device_id,
    r.requester_public_key,
    r.requester_label,
    r.created_at,
    r.expires_at
  FROM public.device_link_requests r
  WHERE r.user_id = v_user
    AND r.token_hash = trim(p_token_hash)
    AND r.status = 'pending'
    AND r.expires_at > now()
  LIMIT 1;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_device_link_request_for_approval(text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_device_link_request(
  p_token_hash text,
  p_approver_device_id text,
  p_encrypted_payload text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_approver_device_id IS NULL OR length(trim(p_approver_device_id)) < 8 THEN
    RAISE EXCEPTION 'Invalid approver device';
  END IF;

  IF p_encrypted_payload IS NULL OR length(p_encrypted_payload) < 32 THEN
    RAISE EXCEPTION 'Missing encrypted payload';
  END IF;

  IF length(p_encrypted_payload) > 2097152 THEN
    RAISE EXCEPTION 'Encrypted payload too large';
  END IF;

  UPDATE public.device_link_requests r
  SET
    approver_device_id = trim(p_approver_device_id),
    encrypted_payload = p_encrypted_payload,
    status = 'approved',
    approved_at = now(),
    updated_at = now()
  WHERE r.user_id = v_user
    AND r.token_hash = trim(p_token_hash)
    AND r.status = 'pending'
    AND r.expires_at > now()
    AND r.requester_device_id <> trim(p_approver_device_id)
  RETURNING r.id INTO v_id;

  RETURN v_id IS NOT NULL;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.approve_device_link_request(text, text, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.get_approved_device_link_payload(
  p_token_hash text,
  p_requester_device_id text
)
RETURNS TABLE (
  encrypted_payload text,
  approver_device_id text,
  approved_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  RETURN QUERY
  SELECT
    r.encrypted_payload,
    r.approver_device_id,
    r.approved_at
  FROM public.device_link_requests r
  WHERE r.user_id = v_user
    AND r.token_hash = trim(p_token_hash)
    AND r.requester_device_id = trim(p_requester_device_id)
    AND r.status = 'approved'
    AND r.claimed_at IS NULL
    AND r.expires_at > now()
    AND r.encrypted_payload IS NOT NULL
  LIMIT 1;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_approved_device_link_payload(text, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_device_link_request(
  p_token_hash text,
  p_requester_device_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  UPDATE public.device_link_requests r
  SET
    status = 'claimed',
    claimed_at = now(),
    updated_at = now()
  WHERE r.user_id = v_user
    AND r.token_hash = trim(p_token_hash)
    AND r.requester_device_id = trim(p_requester_device_id)
    AND r.status = 'approved'
    AND r.claimed_at IS NULL
  RETURNING r.id INTO v_id;

  RETURN v_id IS NOT NULL;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.complete_device_link_request(text, text)
  TO authenticated;
