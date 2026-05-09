-- L2 Sender Keys — auto-enable for group conversations with 3+ members.
-- Trigger fires on conversation_participants INSERT/DELETE. Idempotent.

CREATE OR REPLACE FUNCTION public.maybe_enable_sender_keys_for_group()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv_id uuid;
  v_count int;
  v_is_group boolean;
BEGIN
  v_conv_id := COALESCE(NEW.conversation_id, OLD.conversation_id);
  IF v_conv_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT is_group INTO v_is_group FROM public.conversations WHERE id = v_conv_id;
  IF v_is_group IS NOT TRUE THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.conversation_participants
  WHERE conversation_id = v_conv_id;

  -- Auto-enable when group reaches 3+ members. Never auto-disable
  -- (members can leave but the chain stays valid for remaining members).
  IF v_count >= 3 THEN
    UPDATE public.conversations
    SET enable_sender_keys = true
    WHERE id = v_conv_id
      AND (enable_sender_keys IS DISTINCT FROM true);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_enable_sender_keys_on_participants ON public.conversation_participants;
CREATE TRIGGER trg_auto_enable_sender_keys_on_participants
  AFTER INSERT OR DELETE ON public.conversation_participants
  FOR EACH ROW
  EXECUTE FUNCTION public.maybe_enable_sender_keys_for_group();

-- Backfill: enable for every existing 3+ member group.
UPDATE public.conversations c
SET enable_sender_keys = true
WHERE c.is_group = true
  AND COALESCE(c.enable_sender_keys, false) = false
  AND (
    SELECT COUNT(*) FROM public.conversation_participants p WHERE p.conversation_id = c.id
  ) >= 3;

-- Make conversation_participants emit realtime events so clients can rotate
-- their sender-key chain on member changes.
ALTER TABLE public.conversation_participants REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'conversation_participants'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_participants';
  END IF;
END $$;