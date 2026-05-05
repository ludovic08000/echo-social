CREATE TABLE IF NOT EXISTS public.message_device_retry_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  requester_user_id uuid NOT NULL,
  requester_device_id text NOT NULL,
  sender_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT mdrr_unique_request UNIQUE (
    message_id, requester_user_id, requester_device_id, sender_user_id
  )
);

CREATE INDEX IF NOT EXISTS idx_mdrr_sender_pending
  ON public.message_device_retry_requests (sender_user_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_mdrr_requester_pending
  ON public.message_device_retry_requests (requester_user_id, requester_device_id, status, created_at);

ALTER TABLE public.message_device_retry_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Requester can read own retry requests" ON public.message_device_retry_requests;
CREATE POLICY "Requester can read own retry requests"
  ON public.message_device_retry_requests FOR SELECT
  USING (auth.uid() = requester_user_id);

DROP POLICY IF EXISTS "Sender can read assigned retry requests" ON public.message_device_retry_requests;
CREATE POLICY "Sender can read assigned retry requests"
  ON public.message_device_retry_requests FOR SELECT
  USING (auth.uid() = sender_user_id);

DROP TRIGGER IF EXISTS update_message_device_retry_requests_updated_at
  ON public.message_device_retry_requests;
CREATE TRIGGER update_message_device_retry_requests_updated_at
  BEFORE UPDATE ON public.message_device_retry_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP FUNCTION IF EXISTS public.request_device_copy_retry(uuid, uuid, text);
CREATE FUNCTION public.request_device_copy_retry(
  p_message_id uuid, p_sender_user_id uuid, p_requester_device_id text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_requester uuid := auth.uid();
  v_request_id uuid;
BEGIN
  IF v_requester IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_requester_device_id IS NULL OR length(trim(p_requester_device_id)) = 0 THEN
    RAISE EXCEPTION 'Requester device required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.messages m
    JOIN public.conversation_participants cp
      ON cp.conversation_id = m.conversation_id AND cp.user_id = v_requester
    WHERE m.id = p_message_id AND m.sender_id = p_sender_user_id
  ) THEN RAISE EXCEPTION 'Message retry not allowed'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_devices d
    WHERE d.user_id = v_requester AND d.device_id = p_requester_device_id
      AND d.is_active = true AND d.device_public_key IS NOT NULL
      AND length(trim(d.device_public_key)) > 0
  ) THEN RAISE EXCEPTION 'Requester device is not active'; END IF;
  INSERT INTO public.message_device_retry_requests (
    message_id, requester_user_id, requester_device_id, sender_user_id, status, last_error
  ) VALUES (
    p_message_id, v_requester, p_requester_device_id, p_sender_user_id, 'pending', NULL
  )
  ON CONFLICT (message_id, requester_user_id, requester_device_id, sender_user_id)
  DO UPDATE SET status = 'pending', last_error = NULL, updated_at = now()
  RETURNING id INTO v_request_id;
  RETURN v_request_id;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.request_device_copy_retry(uuid, uuid, text) TO authenticated;

DROP FUNCTION IF EXISTS public.list_pending_device_copy_retries(integer);
CREATE FUNCTION public.list_pending_device_copy_retries(p_limit integer DEFAULT 20)
RETURNS TABLE (
  request_id uuid, message_id uuid, conversation_id uuid, message_body text,
  requester_user_id uuid, requester_device_id text, requester_device_public_key text,
  attempt_count integer, created_at timestamp with time zone
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT r.id, r.message_id, m.conversation_id, m.body, r.requester_user_id,
    r.requester_device_id, d.device_public_key, r.attempt_count, r.created_at
  FROM public.message_device_retry_requests r
  JOIN public.messages m ON m.id = r.message_id AND m.sender_id = r.sender_user_id
  JOIN public.conversation_participants sp
    ON sp.conversation_id = m.conversation_id AND sp.user_id = r.sender_user_id
  JOIN public.conversation_participants rp
    ON rp.conversation_id = m.conversation_id AND rp.user_id = r.requester_user_id
  JOIN public.user_devices d
    ON d.user_id = r.requester_user_id AND d.device_id = r.requester_device_id AND d.is_active = true
  WHERE r.sender_user_id = auth.uid() AND r.status = 'pending'
  ORDER BY r.created_at ASC
  LIMIT greatest(1, least(coalesce(p_limit, 20), 50));
$function$;
GRANT EXECUTE ON FUNCTION public.list_pending_device_copy_retries(integer) TO authenticated;

DROP FUNCTION IF EXISTS public.complete_device_copy_retry(uuid, text, text);
CREATE FUNCTION public.complete_device_copy_retry(
  p_request_id uuid, p_encrypted_body text, p_sender_device_id text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_sender uuid := auth.uid();
  v_req public.message_device_retry_requests%ROWTYPE;
BEGIN
  IF v_sender IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_encrypted_body IS NULL OR length(trim(p_encrypted_body)) = 0 THEN
    RAISE EXCEPTION 'Encrypted body required'; END IF;
  IF p_sender_device_id IS NULL OR length(trim(p_sender_device_id)) = 0 THEN
    RAISE EXCEPTION 'Sender device required'; END IF;
  SELECT * INTO v_req FROM public.message_device_retry_requests
  WHERE id = p_request_id AND sender_user_id = v_sender AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Retry request not found'; END IF;
  INSERT INTO public.message_device_copies (
    message_id, recipient_user_id, recipient_device_id, sender_user_id,
    sender_device_id, encrypted_body, created_at
  ) VALUES (
    v_req.message_id, v_req.requester_user_id, v_req.requester_device_id,
    v_req.sender_user_id, p_sender_device_id, p_encrypted_body, now()
  )
  ON CONFLICT (message_id, recipient_device_id) DO UPDATE SET
    recipient_user_id = excluded.recipient_user_id,
    sender_user_id = excluded.sender_user_id,
    sender_device_id = excluded.sender_device_id,
    encrypted_body = excluded.encrypted_body,
    created_at = now(), delivered_at = NULL, read_at = NULL;
  UPDATE public.message_device_retry_requests
  SET status = 'completed', attempt_count = attempt_count + 1,
      last_error = NULL, updated_at = now()
  WHERE id = v_req.id;
  UPDATE public.messages SET body_kind = 'multi_device' WHERE id = v_req.message_id;
  RETURN true;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.complete_device_copy_retry(uuid, text, text) TO authenticated;

DROP FUNCTION IF EXISTS public.mark_device_copy_retry_failed(uuid, text);
CREATE FUNCTION public.mark_device_copy_retry_failed(
  p_request_id uuid, p_error text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_sender uuid := auth.uid();
BEGIN
  IF v_sender IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  UPDATE public.message_device_retry_requests
  SET attempt_count = attempt_count + 1,
      last_error = left(coalesce(p_error, 'retry failed'), 500),
      status = CASE WHEN attempt_count + 1 >= 5 THEN 'failed' ELSE 'pending' END,
      updated_at = now()
  WHERE id = p_request_id AND sender_user_id = v_sender AND status = 'pending';
  RETURN FOUND;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.mark_device_copy_retry_failed(uuid, text) TO authenticated;