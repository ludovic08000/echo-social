-- =========================================================================
-- MESSAGING HARDENING — Strict RLS + Atomic RPCs + Cleanup
-- =========================================================================

-- ------------------------------------------------------------------------
-- 1. CLEANUP: orphan 1-to-1 conversations (1 participant only)
--    These are residue from old client-side insertions that partially failed
--    due to RLS. Safe to delete: no real conversation can have 1 participant.
-- ------------------------------------------------------------------------
WITH orphans AS (
  SELECT c.id
  FROM public.conversations c
  JOIN public.conversation_participants cp ON cp.conversation_id = c.id
  WHERE c.is_group = false
  GROUP BY c.id
  HAVING count(cp.user_id) < 2
)
DELETE FROM public.conversations WHERE id IN (SELECT id FROM orphans);

-- ------------------------------------------------------------------------
-- 2. UNIQUE constraint: prevent duplicate participants in same conversation
-- ------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_participants_conv_user_unique'
  ) THEN
    -- Deduplicate first if any
    DELETE FROM public.conversation_participants a
    USING public.conversation_participants b
    WHERE a.ctid < b.ctid
      AND a.conversation_id = b.conversation_id
      AND a.user_id = b.user_id;

    ALTER TABLE public.conversation_participants
      ADD CONSTRAINT conversation_participants_conv_user_unique
      UNIQUE (conversation_id, user_id);
  END IF;
END$$;

-- Performance index for "list my conversations"
CREATE INDEX IF NOT EXISTS idx_conv_participants_user_id
  ON public.conversation_participants (user_id);

-- ------------------------------------------------------------------------
-- 3. DROP all existing policies on the 3 tables (clean slate)
-- ------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('conversations', 'conversation_participants', 'messages')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
      r.policyname, r.schemaname, r.tablename);
  END LOOP;
END$$;

-- Make sure RLS is enabled
ALTER TABLE public.conversations              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_participants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages                   ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------
-- 4. STRICT RLS POLICIES
-- ------------------------------------------------------------------------

-- conversations: only participants can SELECT/UPDATE; INSERT/DELETE forbidden from client
CREATE POLICY "conv_select_if_participant"
  ON public.conversations
  FOR SELECT
  TO authenticated
  USING (public.is_conversation_participant(id, auth.uid()));

CREATE POLICY "conv_update_if_participant"
  ON public.conversations
  FOR UPDATE
  TO authenticated
  USING (public.is_conversation_participant(id, auth.uid()))
  WITH CHECK (public.is_conversation_participant(id, auth.uid()));

-- INSERT/DELETE on conversations: only via SECURITY DEFINER RPCs

-- conversation_participants: members can SEE all participants of conversations they belong to
CREATE POLICY "cp_select_if_member_of_conv"
  ON public.conversation_participants
  FOR SELECT
  TO authenticated
  USING (public.is_conversation_participant(conversation_id, auth.uid()));

-- A user can only update their own row (e.g. last_read_at)
CREATE POLICY "cp_update_own_row"
  ON public.conversation_participants
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- A user can only DELETE their own row (leave conversation)
CREATE POLICY "cp_delete_own_row"
  ON public.conversation_participants
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- INSERT on conversation_participants: forbidden from client (must use RPCs)
-- (No INSERT policy = no inserts allowed for non-superuser roles.)

-- messages: read/write only for conversation participants; sender_id must match
CREATE POLICY "msg_select_if_participant"
  ON public.messages
  FOR SELECT
  TO authenticated
  USING (public.is_conversation_participant(conversation_id, auth.uid()));

CREATE POLICY "msg_insert_if_participant_and_self"
  ON public.messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = sender_id
    AND public.is_conversation_participant(conversation_id, auth.uid())
  );

CREATE POLICY "msg_delete_own"
  ON public.messages
  FOR DELETE
  TO authenticated
  USING (auth.uid() = sender_id);

-- (No UPDATE policy on messages — messages are immutable from the client.)

-- ------------------------------------------------------------------------
-- 5. RPC: create_or_get_dm_conversation(p_other_user uuid) → uuid
--    Atomic, idempotent, returns existing 1-to-1 conv or creates one.
-- ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_or_get_dm_conversation(p_other_user uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me     uuid := auth.uid();
  v_conv   uuid;
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

  -- Fast path: existing 1-to-1 between us and the peer
  SELECT c.id
    INTO v_conv
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

  -- Create atomically
  INSERT INTO public.conversations (is_group, created_by)
  VALUES (false, v_me)
  RETURNING id INTO v_conv;

  INSERT INTO public.conversation_participants (conversation_id, user_id)
  VALUES (v_conv, v_me), (v_conv, p_other_user)
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

  RETURN v_conv;
END;
$$;

-- ------------------------------------------------------------------------
-- 6. RPC: create_group_conversation(p_name, p_member_ids[]) → uuid
-- ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_group_conversation(
  p_name        text,
  p_member_ids  uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me   uuid := auth.uid();
  v_conv uuid;
  v_clean uuid[];
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'invalid_group_name';
  END IF;
  IF length(btrim(p_name)) > 120 THEN
    RAISE EXCEPTION 'group_name_too_long';
  END IF;
  IF p_member_ids IS NULL OR array_length(p_member_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'no_members';
  END IF;

  -- Dedup + remove self + remove nulls
  SELECT array_agg(DISTINCT m)
    INTO v_clean
  FROM unnest(p_member_ids) AS m
  WHERE m IS NOT NULL AND m <> v_me;

  IF v_clean IS NULL OR array_length(v_clean, 1) < 2 THEN
    RAISE EXCEPTION 'group_needs_min_2_other_members';
  END IF;
  IF array_length(v_clean, 1) > 256 THEN
    RAISE EXCEPTION 'group_too_large';
  END IF;

  INSERT INTO public.conversations (is_group, name, created_by)
  VALUES (true, btrim(p_name), v_me)
  RETURNING id INTO v_conv;

  -- Insert creator + members atomically
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
$$;

-- ------------------------------------------------------------------------
-- 7. RPC: add_group_members(p_conv_id, p_member_ids[])
--    Only the conversation creator (admin) can add members.
-- ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_group_members(
  p_conv_id     uuid,
  p_member_ids  uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me     uuid := auth.uid();
  v_admin  uuid;
  v_group  boolean;
  v_added  integer := 0;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF p_conv_id IS NULL OR p_member_ids IS NULL THEN
    RAISE EXCEPTION 'invalid_args';
  END IF;

  SELECT created_by, is_group
    INTO v_admin, v_group
  FROM public.conversations
  WHERE id = p_conv_id;

  IF v_admin IS NULL THEN RAISE EXCEPTION 'conversation_not_found'; END IF;
  IF v_group IS NOT TRUE THEN RAISE EXCEPTION 'not_a_group'; END IF;
  IF v_admin <> v_me THEN RAISE EXCEPTION 'forbidden_not_admin'; END IF;

  WITH ins AS (
    INSERT INTO public.conversation_participants (conversation_id, user_id)
    SELECT p_conv_id, uid
    FROM unnest(p_member_ids) AS uid
    WHERE uid IS NOT NULL AND uid <> v_me
    ON CONFLICT (conversation_id, user_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_added FROM ins;

  RETURN v_added;
END;
$$;

-- ------------------------------------------------------------------------
-- 8. PERMISSIONS
-- ------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.create_or_get_dm_conversation(uuid)        FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_group_conversation(text, uuid[])    FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_group_members(uuid, uuid[])            FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_or_get_dm_conversation(uuid)     TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_group_conversation(text, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_group_members(uuid, uuid[])         TO authenticated;