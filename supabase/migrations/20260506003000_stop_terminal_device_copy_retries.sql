-- Stop terminal device-copy retry loops for historical messages.
--
-- If the original sender device no longer has plaintext for an old message, it
-- cannot regenerate a safe encrypted copy. Keep the message row intact, mark
-- the retry request failed, and do not allow the requester to reopen the same
-- terminal request endlessly.

DROP FUNCTION IF EXISTS public.request_device_copy_retry(uuid, uuid, text);

CREATE FUNCTION public.request_device_copy_retry(
  p_message_id uuid,
  p_sender_user_id uuid,
  p_requester_device_id text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_requester uuid := auth.uid();
  v_request_id uuid;
BEGIN
  IF v_requester IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_requester_device_id IS NULL OR length(trim(p_requester_device_id)) = 0 THEN
    RAISE EXCEPTION 'Requester device required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.messages m
    JOIN public.conversation_participants cp
      ON cp.conversation_id = m.conversation_id
     AND cp.user_id = v_requester
    WHERE m.id = p_message_id
      AND m.sender_id = p_sender_user_id
  ) THEN
    RAISE EXCEPTION 'Message retry not allowed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_devices d
    WHERE d.user_id = v_requester
      AND d.device_id = p_requester_device_id
      AND d.is_active = true
      AND d.device_public_key IS NOT NULL
      AND length(trim(d.device_public_key)) > 0
  ) THEN
    RAISE EXCEPTION 'Requester device is not active';
  END IF;

  INSERT INTO public.message_device_retry_requests (
    message_id,
    requester_user_id,
    requester_device_id,
    sender_user_id,
    status,
    last_error
  )
  VALUES (
    p_message_id,
    v_requester,
    p_requester_device_id,
    p_sender_user_id,
    'pending',
    NULL
  )
  ON CONFLICT (
    message_id,
    requester_user_id,
    requester_device_id,
    sender_user_id
  )
  DO UPDATE SET
    status = CASE
      WHEN public.message_device_retry_requests.status = 'failed'
       AND coalesce(public.message_device_retry_requests.last_error, '') LIKE 'PLAINTEXT_UNAVAILABLE:%'
      THEN public.message_device_retry_requests.status
      ELSE 'pending'
    END,
    last_error = CASE
      WHEN public.message_device_retry_requests.status = 'failed'
       AND coalesce(public.message_device_retry_requests.last_error, '') LIKE 'PLAINTEXT_UNAVAILABLE:%'
      THEN public.message_device_retry_requests.last_error
      ELSE NULL
    END,
    updated_at = now()
  RETURNING id INTO v_request_id;

  RETURN v_request_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.request_device_copy_retry(uuid, uuid, text)
  TO authenticated;

DROP FUNCTION IF EXISTS public.mark_device_copy_retry_failed(uuid, text);

CREATE FUNCTION public.mark_device_copy_retry_failed(
  p_request_id uuid,
  p_error text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sender uuid := auth.uid();
BEGIN
  IF v_sender IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  UPDATE public.message_device_retry_requests
  SET
    attempt_count = attempt_count + 1,
    last_error = left(coalesce(p_error, 'retry failed'), 500),
    status = CASE
      WHEN coalesce(p_error, '') LIKE 'PLAINTEXT_UNAVAILABLE:%' THEN 'failed'
      WHEN attempt_count + 1 >= 5 THEN 'failed'
      ELSE 'pending'
    END,
    updated_at = now()
  WHERE id = p_request_id
    AND sender_user_id = v_sender
    AND status = 'pending';

  RETURN FOUND;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.mark_device_copy_retry_failed(uuid, text)
  TO authenticated;
