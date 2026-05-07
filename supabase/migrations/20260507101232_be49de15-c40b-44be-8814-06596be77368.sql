
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS view_once boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS viewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS document_url text,
  ADD COLUMN IF NOT EXISTS document_name text,
  ADD COLUMN IF NOT EXISTS document_mime text,
  ADD COLUMN IF NOT EXISTS document_size_bytes integer;

-- When a View Once message is marked as viewed, scrub the payload so even
-- the original ciphertext / blob URL disappears from the row.
CREATE OR REPLACE FUNCTION public.scrub_view_once_on_view()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.view_once = true
     AND NEW.viewed_at IS NOT NULL
     AND (OLD.viewed_at IS NULL)
  THEN
    NEW.body := '[viewed]';
    NEW.image_url := NULL;
    NEW.document_url := NULL;
    NEW.document_name := NULL;
    NEW.document_mime := NULL;
    NEW.document_size_bytes := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_scrub_view_once ON public.messages;
CREATE TRIGGER trg_scrub_view_once
BEFORE UPDATE OF viewed_at ON public.messages
FOR EACH ROW EXECUTE FUNCTION public.scrub_view_once_on_view();

-- Allow the recipient (any conversation participant other than sender) to
-- update viewed_at on a View Once message they receive.
CREATE POLICY "msg_update_view_once_viewer"
ON public.messages FOR UPDATE TO authenticated
USING (
  view_once = true
  AND viewed_at IS NULL
  AND auth.uid() <> sender_id
  AND is_conversation_participant(conversation_id, auth.uid())
)
WITH CHECK (
  view_once = true
  AND auth.uid() <> sender_id
  AND is_conversation_participant(conversation_id, auth.uid())
);
