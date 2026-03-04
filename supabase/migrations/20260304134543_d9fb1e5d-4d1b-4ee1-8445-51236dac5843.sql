
-- Drop the restrictive INSERT policy on conversations
DROP POLICY IF EXISTS "Authenticated users can create conversations" ON public.conversations;

-- Recreate as PERMISSIVE
CREATE POLICY "Authenticated users can create conversations"
ON public.conversations
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() IS NOT NULL);

-- Also fix conversation_participants INSERT if restrictive
DROP POLICY IF EXISTS "Participants can add themselves" ON public.conversation_participants;

-- Ensure there's a permissive INSERT policy for conversation_participants
CREATE POLICY "Users can add conversation participants"
ON public.conversation_participants
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() IS NOT NULL);
