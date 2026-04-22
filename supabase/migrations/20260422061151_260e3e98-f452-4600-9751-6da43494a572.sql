-- Add a fallback RPC: when the device_id has changed (e.g. localStorage cleared),
-- return ALL copies addressed to the current user so the client can try each one.
-- Cryptographic decryption gates which copy actually opens — so this remains secure.
CREATE OR REPLACE FUNCTION public.get_device_copies_for_user(p_message_id uuid)
RETURNS TABLE(
  encrypted_body text,
  sender_user_id uuid,
  sender_device_id text,
  recipient_device_id text,
  created_at timestamp with time zone
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT mdc.encrypted_body, mdc.sender_user_id, mdc.sender_device_id, mdc.recipient_device_id, mdc.created_at
  FROM public.message_device_copies mdc
  WHERE mdc.message_id = p_message_id
    AND mdc.recipient_user_id = auth.uid()
  ORDER BY mdc.created_at ASC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_device_copies_for_user(uuid) TO authenticated;