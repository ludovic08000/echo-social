-- Drop the overly permissive policy
DROP POLICY IF EXISTS "Users can add conversation participants" ON public.conversation_participants;

-- Replace with: users can only add participants to conversations they already belong to
CREATE POLICY "Users can add participants to own conversations"
ON public.conversation_participants
FOR INSERT
TO authenticated
WITH CHECK (
  auth.uid() = user_id
  OR
  is_conversation_participant(conversation_id, auth.uid())
);

-- Remove the now-redundant policy since the new one covers self-insert too
DROP POLICY IF EXISTS "Users can insert own participation" ON public.conversation_participants;