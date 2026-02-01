-- Create a security definer function to check if user is participant
CREATE OR REPLACE FUNCTION public.is_conversation_participant(conv_id uuid, uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM conversation_participants
    WHERE conversation_id = conv_id
      AND user_id = uid
  )
$$;

-- Drop the problematic policy
DROP POLICY IF EXISTS "Users can view conversation participants" ON public.conversation_participants;

-- Create a new policy that uses the security definer function
CREATE POLICY "Users can view conversation participants"
ON public.conversation_participants
FOR SELECT
USING (
  public.is_conversation_participant(conversation_id, auth.uid())
);

-- Also fix the conversations table policy that has a similar issue
DROP POLICY IF EXISTS "Users can view conversations they're part of" ON public.conversations;

CREATE POLICY "Users can view conversations they're part of"
ON public.conversations
FOR SELECT
USING (
  public.is_conversation_participant(id, auth.uid())
);

-- Fix the update policy on conversations to allow updating updated_at
DROP POLICY IF EXISTS "Users can update their conversations" ON public.conversations;

CREATE POLICY "Users can update their conversations"
ON public.conversations
FOR UPDATE
USING (
  public.is_conversation_participant(id, auth.uid())
);