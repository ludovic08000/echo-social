
-- Server-side rate limiting function for messages
CREATE OR REPLACE FUNCTION public.check_message_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  recent_count INTEGER;
  last_body TEXT;
BEGIN
  -- Rate limit: max 20 messages per minute per user
  SELECT COUNT(*) INTO recent_count
  FROM messages
  WHERE sender_id = NEW.sender_id
    AND created_at > (now() - interval '1 minute');

  IF recent_count >= 20 THEN
    RAISE EXCEPTION 'Rate limit exceeded: too many messages per minute';
  END IF;

  -- Duplicate detection: same exact message within 10 seconds
  SELECT body INTO last_body
  FROM messages
  WHERE sender_id = NEW.sender_id
    AND conversation_id = NEW.conversation_id
    AND created_at > (now() - interval '10 seconds')
  ORDER BY created_at DESC
  LIMIT 1;

  IF last_body IS NOT NULL AND last_body = NEW.body THEN
    RAISE EXCEPTION 'Duplicate message detected';
  END IF;

  -- Max message length (2000 chars)
  IF length(NEW.body) > 2000 THEN
    NEW.body := left(NEW.body, 2000);
  END IF;

  RETURN NEW;
END;
$$;

-- Attach trigger to messages table
CREATE TRIGGER check_message_spam
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.check_message_rate_limit();
