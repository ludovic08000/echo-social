CREATE OR REPLACE FUNCTION public.validate_call_participants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Caller must always belong to the conversation
  IF NOT EXISTS (
    SELECT 1 FROM conversation_participants
    WHERE conversation_id = NEW.conversation_id::uuid
      AND user_id = NEW.caller_id
  ) THEN
    RAISE EXCEPTION 'Caller is not a participant of this conversation';
  END IF;

  -- For 1-to-1 calls only, the callee must be in the conversation.
  -- Group calls invite friends freely, so skip this check.
  IF COALESCE(NEW.is_group, false) = false THEN
    IF NOT EXISTS (
      SELECT 1 FROM conversation_participants
      WHERE conversation_id = NEW.conversation_id::uuid
        AND user_id = NEW.callee_id
    ) THEN
      RAISE EXCEPTION 'Callee is not a participant of this conversation';
    END IF;

    IF NEW.caller_id = NEW.callee_id THEN
      RAISE EXCEPTION 'Cannot call yourself';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;