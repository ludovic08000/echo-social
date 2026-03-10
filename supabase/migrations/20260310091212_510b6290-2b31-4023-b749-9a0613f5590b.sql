CREATE OR REPLACE FUNCTION public.check_message_friendship()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  is_friend BOOLEAN;
  conv_other_user_id UUID;
  target_is_minor BOOLEAN;
  sender_is_minor BOOLEAN;
BEGIN
  -- Allow Zeus bot messages through without friendship check
  IF NEW.sender_id = '00000000-0000-0000-0000-000000000001' THEN
    NEW.status := 'delivered';
    RETURN NEW;
  END IF;

  -- Find the other participant in the conversation
  SELECT user_id INTO conv_other_user_id
  FROM conversation_participants
  WHERE conversation_id = NEW.conversation_id
    AND user_id != NEW.sender_id
  LIMIT 1;

  -- If no other user found, deliver normally
  IF conv_other_user_id IS NULL THEN
    NEW.status := 'delivered';
    RETURN NEW;
  END IF;

  -- Allow messages TO Zeus bot without friendship check
  IF conv_other_user_id = '00000000-0000-0000-0000-000000000001' THEN
    NEW.status := 'delivered';
    RETURN NEW;
  END IF;

  -- Check if target is a minor
  SELECT public.is_user_minor(conv_other_user_id) INTO target_is_minor;
  SELECT public.is_user_minor(NEW.sender_id) INTO sender_is_minor;

  -- Check if they are friends (accepted friendship)
  SELECT EXISTS (
    SELECT 1 FROM friendships
    WHERE status = 'accepted'
      AND (
        (requester_id = NEW.sender_id AND addressee_id = conv_other_user_id)
        OR (requester_id = conv_other_user_id AND addressee_id = NEW.sender_id)
      )
  ) INTO is_friend;

  -- MINOR PROTECTION: Block messages from non-friends to minors
  IF target_is_minor AND NOT is_friend THEN
    NEW.status := 'blocked';
    RETURN NEW;
  END IF;

  IF is_friend THEN
    NEW.status := 'delivered';
  ELSE
    NEW.status := 'pending';
    INSERT INTO notifications (user_id, actor_id, type)
    VALUES (conv_other_user_id, NEW.sender_id, 'message');
  END IF;

  RETURN NEW;
END;
$function$;