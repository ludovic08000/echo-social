-- Fix infinite recursion in conversation_participants RLS policies
-- First, drop all existing policies for conversation_participants
DROP POLICY IF EXISTS "Users can view their own participation" ON public.conversation_participants;
DROP POLICY IF EXISTS "Users can view conversations they participate in" ON public.conversation_participants;
DROP POLICY IF EXISTS "Users can insert own participation" ON public.conversation_participants;
DROP POLICY IF EXISTS "Users can update own participation" ON public.conversation_participants;
DROP POLICY IF EXISTS "Users can delete own participation" ON public.conversation_participants;

-- Create simple, non-recursive policies
CREATE POLICY "Users can view own participation"
ON public.conversation_participants
FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own participation"
ON public.conversation_participants
FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own participation"
ON public.conversation_participants
FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own participation"
ON public.conversation_participants
FOR DELETE
USING (auth.uid() = user_id);