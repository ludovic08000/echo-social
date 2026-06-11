DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'archive_body'
  ) THEN
    ALTER TABLE public.messages ADD COLUMN archive_body text NULL;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.set_message_archive_body(
  p_message_id uuid,
  p_archive_body text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_updated integer := 0;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_archive_body IS NULL OR length(trim(p_archive_body)) = 0 THEN
    RETURN false;
  END IF;

  UPDATE public.messages
  SET archive_body = p_archive_body
  WHERE id = p_message_id
    AND sender_id = v_user
    AND archive_body IS NULL
    AND coalesce(view_once, false) = false;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.set_message_archive_body(uuid, text) TO authenticated;