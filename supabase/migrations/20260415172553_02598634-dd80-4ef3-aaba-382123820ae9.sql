CREATE OR REPLACE FUNCTION public.call_signal(p_action text, p_call_id uuid DEFAULT NULL::uuid, p_conversation_id text DEFAULT NULL::text, p_caller_id uuid DEFAULT NULL::uuid, p_callee_id uuid DEFAULT NULL::uuid, p_call_type text DEFAULT 'audio'::text, p_encrypted_call_key text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_row public.active_calls%ROWTYPE;
  v_conv_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Cast conversation_id to uuid once
  IF p_conversation_id IS NOT NULL THEN
    BEGIN
      v_conv_id := p_conversation_id::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Invalid conversation_id format';
    END;
  END IF;

  IF p_action = 'create' THEN
    IF p_caller_id IS NULL OR p_callee_id IS NULL OR v_conv_id IS NULL THEN
      RAISE EXCEPTION 'Missing call parameters';
    END IF;
    IF p_caller_id <> v_user_id THEN
      RAISE EXCEPTION 'Caller mismatch';
    END IF;

    INSERT INTO public.active_calls (
      conversation_id,
      caller_id,
      callee_id,
      call_type,
      status,
      encrypted_call_key
    ) VALUES (
      v_conv_id::text,
      p_caller_id,
      p_callee_id,
      COALESCE(p_call_type, 'audio'),
      'ringing',
      p_encrypted_call_key
    ) RETURNING * INTO v_row;

    RETURN jsonb_build_object('id', v_row.id);
  ELSIF p_action = 'latest_for_callee' THEN
    SELECT * INTO v_row
    FROM public.active_calls
    WHERE callee_id = v_user_id
      AND status = 'ringing'
      AND created_at >= now() - interval '30 seconds'
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_row.id IS NULL THEN
      RETURN NULL;
    END IF;

    RETURN to_jsonb(v_row);
  ELSIF p_action = 'expire_old_for_callee' THEN
    UPDATE public.active_calls
    SET status = 'cancelled', ended_at = now()
    WHERE callee_id = v_user_id
      AND status = 'ringing'
      AND created_at < now() - interval '30 seconds';

    RETURN jsonb_build_object('ok', true);
  ELSIF p_action = 'update_status' THEN
    IF p_call_id IS NULL OR p_status IS NULL THEN
      RAISE EXCEPTION 'Missing status parameters';
    END IF;

    UPDATE public.active_calls
    SET status = p_status,
        answered_at = CASE WHEN p_status = 'answered' THEN now() ELSE answered_at END,
        ended_at = CASE WHEN p_status IN ('declined', 'ended', 'cancelled') THEN now() ELSE ended_at END
    WHERE id = p_call_id
      AND (caller_id = v_user_id OR callee_id = v_user_id)
    RETURNING * INTO v_row;

    IF v_row.id IS NULL THEN
      RAISE EXCEPTION 'Call not found or access denied';
    END IF;

    RETURN to_jsonb(v_row);
  END IF;

  RAISE EXCEPTION 'Unsupported action';
END;
$function$;