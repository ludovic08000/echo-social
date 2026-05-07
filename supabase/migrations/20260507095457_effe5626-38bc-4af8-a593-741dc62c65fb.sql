-- Lot A1 — Disappearing messages
-- Per-conversation TTL setting + per-message expires_at + cron purge

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS disappearing_seconds integer NULL;

COMMENT ON COLUMN public.conversations.disappearing_seconds IS
  'If set, messages auto-delete after N seconds. NULL = disabled. Common: 86400 (24h), 604800 (7d), 2592000 (30d).';

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS expires_at timestamp with time zone NULL;

CREATE INDEX IF NOT EXISTS idx_messages_expires_at
  ON public.messages (expires_at)
  WHERE expires_at IS NOT NULL;

-- Trigger: stamp expires_at on insert based on conversation setting
CREATE OR REPLACE FUNCTION public.set_message_expires_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ttl integer;
BEGIN
  IF NEW.expires_at IS NULL THEN
    SELECT disappearing_seconds INTO ttl
      FROM public.conversations
      WHERE id = NEW.conversation_id;
    IF ttl IS NOT NULL AND ttl > 0 THEN
      NEW.expires_at := now() + (ttl || ' seconds')::interval;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_message_expires_at ON public.messages;
CREATE TRIGGER trg_set_message_expires_at
  BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.set_message_expires_at();

-- Audit log when TTL changes
CREATE OR REPLACE FUNCTION public.log_disappearing_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.disappearing_seconds IS DISTINCT FROM OLD.disappearing_seconds THEN
    INSERT INTO public.messages (conversation_id, sender_id, body, body_kind, status)
    VALUES (
      NEW.id,
      COALESCE(auth.uid(), NEW.created_by),
      CASE
        WHEN NEW.disappearing_seconds IS NULL THEN 'system:disappearing_off'
        ELSE 'system:disappearing_on:' || NEW.disappearing_seconds
      END,
      'system',
      'delivered'
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_disappearing_change ON public.conversations;
CREATE TRIGGER trg_log_disappearing_change
  AFTER UPDATE OF disappearing_seconds ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.log_disappearing_change();