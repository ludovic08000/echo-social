
-- 1) Drop ALL existing client-facing policies on user_chat_pins
DROP POLICY IF EXISTS "Users can check own pin exists" ON public.user_chat_pins;
DROP POLICY IF EXISTS "Users can insert own pin" ON public.user_chat_pins;
DROP POLICY IF EXISTS "Users can update own pin" ON public.user_chat_pins;
DROP POLICY IF EXISTS "Users can read own pin id" ON public.user_chat_pins;

-- 2) Revoke ALL direct access from anon and authenticated roles
REVOKE ALL ON public.user_chat_pins FROM anon, authenticated;

-- 3) Grant only to service_role (used by edge functions)
GRANT ALL ON public.user_chat_pins TO service_role;

-- 4) Create a SECURITY DEFINER function so the client can check if a PIN exists (no secrets exposed)
CREATE OR REPLACE FUNCTION public.has_chat_pin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_chat_pins WHERE user_id = p_user_id
  );
$$;

-- 5) Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION public.has_chat_pin(uuid) TO authenticated;
