
-- Allow users to read their own PIN row
CREATE POLICY "Users can read own pin"
ON public.user_chat_pins
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Allow users to insert their own PIN row
CREATE POLICY "Users can insert own pin"
ON public.user_chat_pins
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

-- Allow users to update their own PIN row
CREATE POLICY "Users can update own pin"
ON public.user_chat_pins
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());
