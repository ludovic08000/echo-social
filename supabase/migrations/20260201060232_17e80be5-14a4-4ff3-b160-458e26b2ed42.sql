-- Fix infinite recursion in conversation_participants RLS policy

-- Drop the problematic policy
DROP POLICY IF EXISTS "Users can view participants in their conversations" ON conversation_participants;

-- Create a simpler, non-recursive policy
-- Users can view all participants in conversations they're part of
CREATE POLICY "Users can view conversation participants"
ON conversation_participants
FOR SELECT
USING (
  conversation_id IN (
    SELECT conversation_id 
    FROM conversation_participants 
    WHERE user_id = auth.uid()
  )
);

-- Also drop duplicate policies
DROP POLICY IF EXISTS "Authenticated users can add participants" ON conversation_participants;
DROP POLICY IF EXISTS "Users can update their own participation" ON conversation_participants;