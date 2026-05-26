-- Bootstrap minimal Echo Social messaging/E2EE schema for a Lovable/Supabase
-- project that does not yet contain the messaging tables.
--
-- This is intentionally additive/idempotent. It creates only the core tables
-- and RPCs required by the encrypted messaging migrations that follow.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE TABLE IF NOT EXISTS public.profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,
  avatar_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS avatar_url text,
  ADD COLUMN IF NOT EXISTS created_at timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone NOT NULL DEFAULT now();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_select_public" ON public.profiles;
DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;

CREATE POLICY "profiles_select_public"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "profiles_insert_own"
  ON public.profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  is_group boolean NOT NULL DEFAULT false,
  name text,
  created_by uuid
);

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS created_at timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS created_by uuid;

CREATE TABLE IF NOT EXISTS public.conversation_participants (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  joined_at timestamp with time zone NOT NULL DEFAULT now(),
  last_read_at timestamp with time zone
);

ALTER TABLE public.conversation_participants
  ADD COLUMN IF NOT EXISTS conversation_id uuid,
  ADD COLUMN IF NOT EXISTS user_id uuid,
  ADD COLUMN IF NOT EXISTS joined_at timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_read_at timestamp with time zone;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'conversation_participants_conv_user_unique'
      AND conrelid = 'public.conversation_participants'::regclass
  ) THEN
    ALTER TABLE public.conversation_participants
      ADD CONSTRAINT conversation_participants_conv_user_unique
      UNIQUE (conversation_id, user_id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_conv_participants_user_id
  ON public.conversation_participants (user_id);

CREATE INDEX IF NOT EXISTS idx_conv_participants_conversation_id
  ON public.conversation_participants (conversation_id);

CREATE TABLE IF NOT EXISTS public.messages (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  body text NOT NULL,
  image_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  body_kind text NOT NULL DEFAULT 'legacy',
  status text NOT NULL DEFAULT 'delivered'
);

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS conversation_id uuid,
  ADD COLUMN IF NOT EXISTS sender_id uuid,
  ADD COLUMN IF NOT EXISTS body text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS created_at timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS body_kind text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'delivered';

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON public.messages (conversation_id);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON public.messages (created_at);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON public.messages (conversation_id, created_at DESC);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_conversation_participant(conv_id uuid, uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.conversation_participants cp
    WHERE cp.conversation_id = conv_id
      AND cp.user_id = uid
  );
$function$;

GRANT EXECUTE ON FUNCTION public.is_conversation_participant(uuid, uuid)
  TO authenticated;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('conversations', 'conversation_participants', 'messages')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END;
$$;

CREATE POLICY "conv_select_if_participant"
  ON public.conversations FOR SELECT
  TO authenticated
  USING (public.is_conversation_participant(id, auth.uid()));

CREATE POLICY "conv_update_if_participant"
  ON public.conversations FOR UPDATE
  TO authenticated
  USING (public.is_conversation_participant(id, auth.uid()))
  WITH CHECK (public.is_conversation_participant(id, auth.uid()));

CREATE POLICY "cp_select_if_member_of_conv"
  ON public.conversation_participants FOR SELECT
  TO authenticated
  USING (public.is_conversation_participant(conversation_id, auth.uid()));

CREATE POLICY "cp_update_own_row"
  ON public.conversation_participants FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "cp_delete_own_row"
  ON public.conversation_participants FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "msg_select_if_participant"
  ON public.messages FOR SELECT
  TO authenticated
  USING (public.is_conversation_participant(conversation_id, auth.uid()));

CREATE POLICY "msg_insert_if_participant_and_self"
  ON public.messages FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND public.is_conversation_participant(conversation_id, auth.uid())
  );

CREATE POLICY "msg_delete_own"
  ON public.messages FOR DELETE
  TO authenticated
  USING (auth.uid() = sender_id);

CREATE OR REPLACE FUNCTION public.create_or_get_dm_conversation(p_other_user uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_conv uuid;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_other_user IS NULL THEN
    RAISE EXCEPTION 'invalid_peer';
  END IF;
  IF p_other_user = v_me THEN
    RAISE EXCEPTION 'cannot_dm_self';
  END IF;

  SELECT c.id INTO v_conv
  FROM public.conversations c
  WHERE c.is_group = false
    AND EXISTS (
      SELECT 1 FROM public.conversation_participants p1
      WHERE p1.conversation_id = c.id AND p1.user_id = v_me
    )
    AND EXISTS (
      SELECT 1 FROM public.conversation_participants p2
      WHERE p2.conversation_id = c.id AND p2.user_id = p_other_user
    )
    AND (
      SELECT count(*) FROM public.conversation_participants pall
      WHERE pall.conversation_id = c.id
    ) = 2
  ORDER BY c.created_at ASC
  LIMIT 1;

  IF v_conv IS NOT NULL THEN
    RETURN v_conv;
  END IF;

  INSERT INTO public.conversations (is_group, created_by)
  VALUES (false, v_me)
  RETURNING id INTO v_conv;

  INSERT INTO public.conversation_participants (conversation_id, user_id)
  VALUES (v_conv, v_me), (v_conv, p_other_user)
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

  RETURN v_conv;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_group_conversation(
  p_name text,
  p_member_ids uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_conv uuid;
  v_clean uuid[];
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'invalid_group_name';
  END IF;

  SELECT array_agg(DISTINCT m)
  INTO v_clean
  FROM unnest(p_member_ids) AS m
  WHERE m IS NOT NULL AND m <> v_me;

  IF v_clean IS NULL OR array_length(v_clean, 1) < 2 THEN
    RAISE EXCEPTION 'group_needs_min_2_other_members';
  END IF;

  INSERT INTO public.conversations (is_group, name, created_by)
  VALUES (true, left(btrim(p_name), 120), v_me)
  RETURNING id INTO v_conv;

  INSERT INTO public.conversation_participants (conversation_id, user_id)
  SELECT v_conv, uid
  FROM (
    SELECT v_me AS uid
    UNION
    SELECT unnest(v_clean)
  ) s
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

  RETURN v_conv;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_conversations_with_details(p_user_id uuid)
RETURNS TABLE (
  conv_id uuid,
  conv_created_at timestamp with time zone,
  conv_updated_at timestamp with time zone,
  is_group boolean,
  conv_name text,
  created_by uuid,
  other_user_id uuid,
  other_name text,
  other_avatar text,
  last_message_body text,
  last_message_at timestamp with time zone,
  last_message_sender uuid,
  unread_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH my_convs AS (
    SELECT cp.conversation_id, cp.last_read_at
    FROM public.conversation_participants cp
    WHERE cp.user_id = p_user_id
  ),
  last_msgs AS (
    SELECT DISTINCT ON (m.conversation_id)
      m.conversation_id,
      m.body,
      m.created_at,
      m.sender_id
    FROM public.messages m
    JOIN my_convs mc ON mc.conversation_id = m.conversation_id
    ORDER BY m.conversation_id, m.created_at DESC
  ),
  unreads AS (
    SELECT m.conversation_id, count(*) AS cnt
    FROM public.messages m
    JOIN my_convs mc ON mc.conversation_id = m.conversation_id
    WHERE m.sender_id <> p_user_id
      AND (mc.last_read_at IS NULL OR m.created_at > mc.last_read_at)
      AND m.status = 'delivered'
    GROUP BY m.conversation_id
  ),
  other_parts AS (
    SELECT DISTINCT ON (cp.conversation_id)
      cp.conversation_id,
      cp.user_id,
      pr.name,
      pr.avatar_url
    FROM public.conversation_participants cp
    JOIN my_convs mc ON mc.conversation_id = cp.conversation_id
    LEFT JOIN public.profiles pr ON pr.user_id = cp.user_id
    WHERE cp.user_id <> p_user_id
    ORDER BY cp.conversation_id, cp.joined_at
  )
  SELECT
    c.id,
    c.created_at,
    c.updated_at,
    c.is_group,
    c.name,
    c.created_by,
    op.user_id,
    COALESCE(op.name, 'Unknown'),
    op.avatar_url,
    lm.body,
    lm.created_at,
    lm.sender_id,
    COALESCE(u.cnt, 0)
  FROM public.conversations c
  JOIN my_convs mc ON mc.conversation_id = c.id
  LEFT JOIN other_parts op ON op.conversation_id = c.id
  LEFT JOIN last_msgs lm ON lm.conversation_id = c.id
  LEFT JOIN unreads u ON u.conversation_id = c.id
  ORDER BY COALESCE(lm.created_at, c.updated_at) DESC;
$function$;

REVOKE ALL ON FUNCTION public.create_or_get_dm_conversation(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_group_conversation(text, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_conversations_with_details(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_or_get_dm_conversation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_group_conversation(text, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_conversations_with_details(uuid) TO authenticated;

CREATE TABLE IF NOT EXISTS public.message_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (message_id, user_id)
);

ALTER TABLE public.message_deletions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can hide messages for themselves" ON public.message_deletions;
DROP POLICY IF EXISTS "Users can view their own deletions" ON public.message_deletions;
DROP POLICY IF EXISTS "Users can undo deletions" ON public.message_deletions;

CREATE POLICY "Users can hide messages for themselves"
  ON public.message_deletions FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view their own deletions"
  ON public.message_deletions FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can undo deletions"
  ON public.message_deletions FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_message_deletions_user
  ON public.message_deletions (user_id, message_id);

CREATE TABLE IF NOT EXISTS public.user_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  encrypted_blob text NOT NULL,
  salt text NOT NULL,
  iv text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  backup_type text NOT NULL DEFAULT 'account',
  wrapped_master_key text,
  master_key_iv text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.user_backups
  ADD COLUMN IF NOT EXISTS backup_type text NOT NULL DEFAULT 'account',
  ADD COLUMN IF NOT EXISTS wrapped_master_key text,
  ADD COLUMN IF NOT EXISTS master_key_iv text;

CREATE UNIQUE INDEX IF NOT EXISTS user_backups_user_id_backup_type_key
  ON public.user_backups (user_id, backup_type);

ALTER TABLE public.user_backups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own backup" ON public.user_backups;
DROP POLICY IF EXISTS "Users can insert own backup" ON public.user_backups;
DROP POLICY IF EXISTS "Users can update own backup" ON public.user_backups;
DROP POLICY IF EXISTS "Users can delete own backup" ON public.user_backups;

CREATE POLICY "Users can read own backup"
  ON public.user_backups FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own backup"
  ON public.user_backups FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own backup"
  ON public.user_backups FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own backup"
  ON public.user_backups FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS public.user_chat_pins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  pin_hash text NOT NULL,
  salt text NOT NULL,
  pin_mode text NOT NULL DEFAULT 'every_open',
  reset_code_hash text,
  reset_code_salt text,
  reset_code_expires timestamp with time zone,
  failed_attempts integer DEFAULT 0,
  locked_until timestamp with time zone,
  backup_wrap_secret text NOT NULL DEFAULT encode(gen_random_bytes(32), 'base64'),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.user_chat_pins
  ADD COLUMN IF NOT EXISTS pin_mode text NOT NULL DEFAULT 'every_open',
  ADD COLUMN IF NOT EXISTS reset_code_hash text,
  ADD COLUMN IF NOT EXISTS reset_code_salt text,
  ADD COLUMN IF NOT EXISTS reset_code_expires timestamp with time zone,
  ADD COLUMN IF NOT EXISTS failed_attempts integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until timestamp with time zone,
  ADD COLUMN IF NOT EXISTS backup_wrap_secret text;

UPDATE public.user_chat_pins
SET backup_wrap_secret = encode(gen_random_bytes(32), 'base64')
WHERE backup_wrap_secret IS NULL;

ALTER TABLE public.user_chat_pins
  ALTER COLUMN backup_wrap_secret SET NOT NULL;

ALTER TABLE public.user_chat_pins ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS update_conversations_updated_at ON public.conversations;
CREATE TRIGGER update_conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_user_chat_pins_updated_at ON public.user_chat_pins;
CREATE TRIGGER update_user_chat_pins_updated_at
  BEFORE UPDATE ON public.user_chat_pins
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_participants TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.message_deletions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_backups TO authenticated;
GRANT ALL ON public.user_chat_pins TO service_role;

DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.message_deletions;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END;
$$;
