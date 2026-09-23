-- Direct messages are routed immediately, whether or not the two adults are
-- friends. The only remaining social-graph delivery rule is the existing
-- protection that blocks a non-friend from messaging a minor.

DROP TRIGGER IF EXISTS check_message_friendship_trigger ON public.messages;
DROP FUNCTION IF EXISTS public.check_message_friendship();

CREATE OR REPLACE FUNCTION public.route_direct_message_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recipient_id uuid;
  v_is_group boolean := false;
  v_is_friend boolean := false;
BEGIN
  -- Zeus/system traffic and group traffic are routed immediately.
  NEW.status := 'delivered';
  IF NEW.sender_id = '00000000-0000-0000-0000-000000000001'::uuid THEN
    RETURN NEW;
  END IF;

  SELECT c.is_group
    INTO v_is_group
  FROM public.conversations AS c
  WHERE c.id = NEW.conversation_id;

  IF COALESCE(v_is_group, false) THEN
    RETURN NEW;
  END IF;

  SELECT cp.user_id
    INTO v_recipient_id
  FROM public.conversation_participants AS cp
  WHERE cp.conversation_id = NEW.conversation_id
    AND cp.user_id <> NEW.sender_id
  ORDER BY cp.joined_at, cp.user_id
  LIMIT 1;

  IF v_recipient_id IS NULL
     OR v_recipient_id = '00000000-0000-0000-0000-000000000001'::uuid THEN
    RETURN NEW;
  END IF;

  -- Preserve the minor-safety boundary without imposing a message-request
  -- queue on adult recipients.
  IF COALESCE(public.is_user_minor(v_recipient_id), false) THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.friendships AS f
      WHERE f.status = 'accepted'
        AND (
          (f.requester_id = NEW.sender_id AND f.addressee_id = v_recipient_id)
          OR
          (f.requester_id = v_recipient_id AND f.addressee_id = NEW.sender_id)
        )
    )
    INTO v_is_friend;

    IF NOT v_is_friend THEN
      NEW.status := 'blocked';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.route_direct_message_delivery() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_direct_message_delivery() FROM anon;
REVOKE ALL ON FUNCTION public.route_direct_message_delivery() FROM authenticated;

CREATE TRIGGER route_direct_message_delivery_trigger
  BEFORE INSERT ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.route_direct_message_delivery();

-- Migrate the old request queue. Apply the minor rule first, then deliver all
-- other pending direct/group messages so no historical conversation remains
-- stuck behind the removed friendship gate.
WITH protected_pending AS (
  SELECT m.id
  FROM public.messages AS m
  JOIN public.conversations AS c
    ON c.id = m.conversation_id
   AND c.is_group = false
  JOIN LATERAL (
    SELECT cp.user_id
    FROM public.conversation_participants AS cp
    WHERE cp.conversation_id = m.conversation_id
      AND cp.user_id <> m.sender_id
    ORDER BY cp.joined_at, cp.user_id
    LIMIT 1
  ) AS recipient ON true
  WHERE m.status = 'pending'
    AND m.sender_id <> '00000000-0000-0000-0000-000000000001'::uuid
    AND recipient.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
    AND COALESCE(public.is_user_minor(recipient.user_id), false)
    AND NOT EXISTS (
      SELECT 1
      FROM public.friendships AS f
      WHERE f.status = 'accepted'
        AND (
          (f.requester_id = m.sender_id AND f.addressee_id = recipient.user_id)
          OR
          (f.requester_id = recipient.user_id AND f.addressee_id = m.sender_id)
        )
    )
)
UPDATE public.messages AS m
SET status = 'blocked'
WHERE m.id IN (SELECT id FROM protected_pending);

UPDATE public.messages
SET status = 'delivered'
WHERE status = 'pending';
