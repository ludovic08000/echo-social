CREATE OR REPLACE FUNCTION public.validate_call_participants()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Verify caller belongs to the conversation (cast text to uuid)
  IF NOT EXISTS (
    SELECT 1 FROM conversation_participants
    WHERE conversation_id = NEW.conversation_id::uuid
      AND user_id = NEW.caller_id
  ) THEN
    RAISE EXCEPTION 'Caller is not a participant of this conversation';
  END IF;

  -- Verify callee belongs to the conversation
  IF NOT EXISTS (
    SELECT 1 FROM conversation_participants
    WHERE conversation_id = NEW.conversation_id::uuid
      AND user_id = NEW.callee_id
  ) THEN
    RAISE EXCEPTION 'Callee is not a participant of this conversation';
  END IF;

  -- Prevent calling yourself
  IF NEW.caller_id = NEW.callee_id THEN
    RAISE EXCEPTION 'Cannot call yourself';
  END IF;

  RETURN NEW;
END;
$function$;