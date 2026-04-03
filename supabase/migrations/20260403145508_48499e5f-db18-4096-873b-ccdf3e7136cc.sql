ALTER TABLE public.user_chat_pins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own pin" ON public.user_chat_pins;
DROP POLICY IF EXISTS "Users can insert own pin" ON public.user_chat_pins;
DROP POLICY IF EXISTS "Users can update own pin" ON public.user_chat_pins;
DROP POLICY IF EXISTS "Users can delete own pin" ON public.user_chat_pins;

CREATE POLICY "Users can read own pin"
ON public.user_chat_pins
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

CREATE POLICY "Users can insert own pin"
ON public.user_chat_pins
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own pin"
ON public.user_chat_pins
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own pin"
ON public.user_chat_pins
FOR DELETE
TO authenticated
USING (user_id = auth.uid());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_chat_pins TO authenticated;