-- Lot 1: Conversation Archive Keys (Encrypted History Backup)

CREATE TABLE IF NOT EXISTS public.conversation_archive_keys (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  wrapped_key text NOT NULL,
  kdf_version smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  UNIQUE (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_archive_keys_user ON public.conversation_archive_keys(user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_archive_keys TO authenticated;
GRANT ALL ON public.conversation_archive_keys TO service_role;

ALTER TABLE public.conversation_archive_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "archive_keys_owner_select" ON public.conversation_archive_keys;
CREATE POLICY "archive_keys_owner_select" ON public.conversation_archive_keys
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "archive_keys_owner_insert" ON public.conversation_archive_keys;
CREATE POLICY "archive_keys_owner_insert" ON public.conversation_archive_keys
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "archive_keys_owner_update" ON public.conversation_archive_keys;
CREATE POLICY "archive_keys_owner_update" ON public.conversation_archive_keys
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "archive_keys_owner_delete" ON public.conversation_archive_keys;
CREATE POLICY "archive_keys_owner_delete" ON public.conversation_archive_keys
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Add archive_body column to messages (nullable for backward compat)
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS archive_body text;

-- Make archive_body immutable after first set (prevent tampering)
CREATE OR REPLACE FUNCTION public.protect_message_archive_body()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.archive_body IS NOT NULL AND NEW.archive_body IS DISTINCT FROM OLD.archive_body THEN
    RAISE EXCEPTION 'archive_body is immutable once set';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_archive_body ON public.messages;
CREATE TRIGGER protect_archive_body
  BEFORE UPDATE ON public.messages
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_message_archive_body();

-- Helper RPC: fetch all archive keys for the authenticated user (on unlock)
CREATE OR REPLACE FUNCTION public.get_user_archive_keys()
RETURNS TABLE (conversation_id uuid, wrapped_key text, kdf_version smallint, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT conversation_id, wrapped_key, kdf_version, created_at
  FROM public.conversation_archive_keys
  WHERE user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.get_user_archive_keys() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_archive_keys() TO authenticated;