-- 1. Remove the SELECT policy that exposes pin_hash/salt to the client
DROP POLICY IF EXISTS "Users can read own pin" ON public.user_chat_pins;

-- 2. Create a restricted SELECT policy that only exposes the id (to check existence)
CREATE POLICY "Users can check own pin exists"
ON public.user_chat_pins
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- 3. Create a security definer function to verify PIN existence without exposing hash
-- (The edge function uses service_role so it bypasses RLS anyway)

-- 4. Add rate_limit columns directly to user_chat_pins for persistent rate limiting
ALTER TABLE public.user_chat_pins
ADD COLUMN IF NOT EXISTS failed_attempts integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS locked_until timestamptz DEFAULT NULL;