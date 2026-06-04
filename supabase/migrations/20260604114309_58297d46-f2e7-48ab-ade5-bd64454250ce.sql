DROP FUNCTION IF EXISTS public.request_message_refanout(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.request_device_copy_retry(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.request_device_copy_retry(
  p_message_id uuid,
  p_sender_user_id uuid,
  p_requester_device_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_requester uuid := auth.uid();
  v_message_sender uuid;
  v_is_participant boolean;
  v_existing public.device_copy_retry_requests%ROWTYPE;
BEGIN
  IF v_requester IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  END IF;

  SELECT m.sender_id INTO v_message_sender
  FROM public.messages m
  WHERE m.id = p_message_id;

  IF v_message_sender IS NULL OR v_message_sender <> p_sender_user_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'MESSAGE_SENDER_MISMATCH');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.messages m
    JOIN public.conversation_participants cp ON cp.conversation_id = m.conversation_id
    WHERE m.id = p_message_id
      AND cp.user_id = v_requester
  ) INTO v_is_participant;

  IF NOT v_is_participant THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_CONVERSATION_PARTICIPANT');
  END IF;

  SELECT * INTO v_existing
  FROM public.device_copy_retry_requests
  WHERE message_id = p_message_id
    AND sender_user_id = p_sender_user_id
    AND requester_user_id = v_requester
    AND requester_device_id = p_requester_device_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'done' THEN
      RETURN jsonb_build_object('ok', true, 'code', 'RETRY_ALREADY_DONE');
    END IF;

    IF v_existing.status = 'failed' OR v_existing.attempts >= 5 THEN
      UPDATE public.device_copy_retry_requests
      SET status = 'failed',
          last_error = coalesce(last_error, 'retry_budget_exhausted'),
          updated_at = now()
      WHERE id = v_existing.id;
      RETURN jsonb_build_object('ok', false, 'code', 'RETRY_BUDGET_EXHAUSTED');
    END IF;

    UPDATE public.device_copy_retry_requests
    SET status = 'pending',
        updated_at = now(),
        last_error = NULL
    WHERE id = v_existing.id;

    RETURN jsonb_build_object('ok', true, 'code', 'RETRY_REQUEST_QUEUED');
  END IF;

  INSERT INTO public.device_copy_retry_requests (
    message_id,
    sender_user_id,
    requester_user_id,
    requester_device_id,
    status,
    attempts,
    updated_at
  ) VALUES (
    p_message_id,
    p_sender_user_id,
    v_requester,
    p_requester_device_id,
    'pending',
    0,
    now()
  );

  RETURN jsonb_build_object('ok', true, 'code', 'RETRY_REQUEST_QUEUED');
END;
$function$;

GRANT EXECUTE ON FUNCTION public.request_device_copy_retry(uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.request_message_refanout(
  p_message_id uuid,
  p_sender_user_id uuid,
  p_requester_device_id text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.request_device_copy_retry(
    p_message_id,
    p_sender_user_id,
    p_requester_device_id
  );
$function$;

GRANT EXECUTE ON FUNCTION public.request_message_refanout(uuid, uuid, text) TO authenticated;

UPDATE public.device_copy_retry_requests
SET status = 'failed',
    last_error = coalesce(last_error, 'retry_budget_exhausted'),
    updated_at = now()
WHERE status = 'pending'
  AND attempts >= 5;