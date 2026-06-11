DROP FUNCTION IF EXISTS public.list_pending_device_copy_retries(integer);
DROP FUNCTION IF EXISTS public.complete_device_copy_retry(uuid, text, text);
DROP FUNCTION IF EXISTS public.mark_device_copy_retry_failed(uuid, text);

CREATE OR REPLACE FUNCTION public.list_pending_device_copy_retries(
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  request_id uuid,
  message_id uuid,
  conversation_id uuid,
  message_body text,
  requester_user_id uuid,
  requester_device_id text,
  requester_device_public_key text,
  attempt_count integer,
  created_at timestamp with time zone
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    r.id AS request_id,
    r.message_id,
    m.conversation_id,
    m.body AS message_body,
    r.requester_user_id,
    r.requester_device_id,
    d.device_public_key AS requester_device_public_key,
    r.attempts AS attempt_count,
    r.created_at
  FROM public.device_copy_retry_requests r
  JOIN public.messages m
    ON m.id = r.message_id
   AND m.sender_id = r.sender_user_id
  JOIN public.conversation_participants sp
    ON sp.conversation_id = m.conversation_id
   AND sp.user_id = r.sender_user_id
  JOIN public.conversation_participants rp
    ON rp.conversation_id = m.conversation_id
   AND rp.user_id = r.requester_user_id
  JOIN public.user_devices d
    ON d.user_id = r.requester_user_id
   AND d.device_id = r.requester_device_id
   AND d.is_active = true
   AND d.revoked_at IS NULL
   AND d.device_public_key IS NOT NULL
  WHERE r.sender_user_id = auth.uid()
    AND r.status = 'pending'
    AND r.attempts < 5
  ORDER BY r.created_at ASC
  LIMIT greatest(1, least(coalesce(p_limit, 20), 50));
$function$;

GRANT EXECUTE ON FUNCTION public.list_pending_device_copy_retries(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_device_copy_retry(
  p_request_id uuid,
  p_encrypted_body text,
  p_sender_device_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sender uuid := auth.uid();
  v_req public.device_copy_retry_requests%ROWTYPE;
BEGIN
  IF v_sender IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  END IF;

  IF p_encrypted_body IS NULL OR length(trim(p_encrypted_body)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EMPTY_ENCRYPTED_BODY');
  END IF;

  IF p_sender_device_id IS NULL OR length(trim(p_sender_device_id)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'EMPTY_SENDER_DEVICE');
  END IF;

  SELECT * INTO v_req
  FROM public.device_copy_retry_requests
  WHERE id = p_request_id
    AND sender_user_id = v_sender
    AND status = 'pending'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND');
  END IF;

  INSERT INTO public.message_device_copies (
    message_id,
    recipient_user_id,
    recipient_device_id,
    sender_user_id,
    sender_device_id,
    encrypted_body,
    created_at
  ) VALUES (
    v_req.message_id,
    v_req.requester_user_id,
    v_req.requester_device_id,
    v_sender,
    p_sender_device_id,
    p_encrypted_body,
    now()
  )
  ON CONFLICT (message_id, recipient_device_id) DO UPDATE SET
    recipient_user_id = excluded.recipient_user_id,
    sender_user_id = excluded.sender_user_id,
    sender_device_id = excluded.sender_device_id,
    encrypted_body = excluded.encrypted_body,
    created_at = now(),
    delivered_at = NULL,
    read_at = NULL;

  UPDATE public.device_copy_retry_requests
  SET status = 'done',
      attempts = attempts + 1,
      last_error = NULL,
      updated_at = now()
  WHERE id = v_req.id;

  UPDATE public.messages
  SET body_kind = 'multi_device'
  WHERE id = v_req.message_id;

  RETURN jsonb_build_object('ok', true, 'code', 'DEVICE_COPY_RETRY_COMPLETED');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.complete_device_copy_retry(uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_device_copy_retry_failed(
  p_request_id uuid,
  p_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sender uuid := auth.uid();
BEGIN
  IF v_sender IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  END IF;

  UPDATE public.device_copy_retry_requests
  SET attempts = attempts + 1,
      last_error = left(coalesce(p_error, 'retry failed'), 500),
      status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END,
      updated_at = now()
  WHERE id = p_request_id
    AND sender_user_id = v_sender
    AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND');
  END IF;

  RETURN jsonb_build_object('ok', true, 'code', 'DEVICE_COPY_RETRY_FAILED');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.mark_device_copy_retry_failed(uuid, text) TO authenticated;