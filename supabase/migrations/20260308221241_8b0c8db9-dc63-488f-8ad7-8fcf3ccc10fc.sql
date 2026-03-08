
-- Add is_minor computed helper + function to check if a user is minor
CREATE OR REPLACE FUNCTION public.is_user_minor(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM parental_controls
    WHERE user_id = p_user_id AND is_active = true
  );
$$;

-- Update the check_message_friendship trigger to block messages to minors from non-friends
CREATE OR REPLACE FUNCTION public.check_message_friendship()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  is_friend BOOLEAN;
  conv_other_user_id UUID;
  target_is_minor BOOLEAN;
  sender_is_minor BOOLEAN;
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
    -- Block the message entirely
    NEW.status := 'blocked';
    RETURN NEW;
  END IF;

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

-- Table to track adult-minor contact attempts for detection
CREATE TABLE IF NOT EXISTS public.minor_contact_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adult_user_id uuid NOT NULL,
  minor_user_id uuid NOT NULL,
  contact_type text NOT NULL DEFAULT 'message',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.minor_contact_logs ENABLE ROW LEVEL SECURITY;

-- Only service role can read/write
CREATE POLICY "Service role only" ON public.minor_contact_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_minor_contact_logs_adult ON public.minor_contact_logs(adult_user_id, created_at DESC);
