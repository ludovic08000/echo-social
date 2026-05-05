-- Lock down chat PIN secrets again.
-- Client code may read/update only non-secret settings through SECURITY DEFINER RPCs.

ALTER TABLE public.user_chat_pins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own pin" ON public.user_chat_pins;
DROP POLICY IF EXISTS "Users can insert own pin" ON public.user_chat_pins;
DROP POLICY IF EXISTS "Users can update own pin" ON public.user_chat_pins;
DROP POLICY IF EXISTS "Users can delete own pin" ON public.user_chat_pins;
DROP POLICY IF EXISTS "Users can check own pin exists" ON public.user_chat_pins;
DROP POLICY IF EXISTS "Users can read own pin id" ON public.user_chat_pins;

REVOKE ALL ON public.user_chat_pins FROM anon, authenticated;
GRANT ALL ON public.user_chat_pins TO service_role;

CREATE OR REPLACE FUNCTION public.has_chat_pin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() = p_user_id
    AND EXISTS (
      SELECT 1
      FROM public.user_chat_pins
      WHERE user_id = p_user_id
    );
$$;

REVOKE ALL ON FUNCTION public.has_chat_pin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_chat_pin(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_chat_pin_settings()
RETURNS TABLE(pin_mode text, has_pin boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(p.pin_mode, 'every_open') AS pin_mode,
    p.user_id IS NOT NULL AS has_pin
  FROM (SELECT auth.uid() AS user_id) AS me
  LEFT JOIN public.user_chat_pins p ON p.user_id = me.user_id
  WHERE me.user_id IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.get_chat_pin_settings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_chat_pin_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.update_chat_pin_mode(p_pin_mode text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_mode text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  IF p_pin_mode NOT IN ('every_open', 'once_per_session', 'on_inactivity', 'on_return') THEN
    RAISE EXCEPTION 'invalid PIN mode';
  END IF;

  UPDATE public.user_chat_pins
  SET pin_mode = p_pin_mode,
      updated_at = now()
  WHERE user_id = auth.uid()
  RETURNING pin_mode INTO v_mode;

  IF v_mode IS NULL THEN
    RAISE EXCEPTION 'chat PIN is not configured';
  END IF;

  RETURN v_mode;
END;
$$;

REVOKE ALL ON FUNCTION public.update_chat_pin_mode(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_chat_pin_mode(text) TO authenticated;
