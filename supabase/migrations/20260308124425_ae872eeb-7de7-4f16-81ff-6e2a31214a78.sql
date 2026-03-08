
-- Add status column to messages for message request system
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'delivered';

-- Add message_requests notification type if not exists (we use the existing notification system)

-- Create a trigger function that sets messages to 'pending' if sender is not a friend
CREATE OR REPLACE FUNCTION public.check_message_friendship()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  is_friend BOOLEAN;
  conv_other_user_id UUID;
BEGIN
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

  -- Check if they are friends (accepted friendship)
  SELECT EXISTS (
    SELECT 1 FROM friendships
    WHERE status = 'accepted'
      AND (
        (requester_id = NEW.sender_id AND addressee_id = conv_other_user_id)
        OR (requester_id = conv_other_user_id AND addressee_id = NEW.sender_id)
      )
  ) INTO is_friend;

  IF is_friend THEN
    NEW.status := 'delivered';
  ELSE
    NEW.status := 'pending';
    -- Create a notification for the recipient about the message request
    INSERT INTO notifications (user_id, actor_id, type)
    VALUES (conv_other_user_id, NEW.sender_id, 'message');
  END IF;

  RETURN NEW;
END;
$$;

-- Attach trigger (before the spam trigger, so friendship check runs first)
CREATE TRIGGER check_message_friendship_trigger
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.check_message_friendship();
