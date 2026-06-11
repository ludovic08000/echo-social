-- Harden multi-device message copies against spoofed plaintext fallback.
-- A copy is valid only when it belongs to a real parent message sent by the
-- authenticated sender and addressed to an active device of a participant.

DROP POLICY IF EXISTS "Recipient can read own device copy" ON public.message_device_copies;
DROP POLICY IF EXISTS "Sender can read copies they sent" ON public.message_device_copies;
DROP POLICY IF EXISTS "Sender can insert device copies" ON public.message_device_copies;
DROP POLICY IF EXISTS "Recipient can mark delivered/read" ON public.message_device_copies;

CREATE POLICY "Recipient can read own device copy"
  ON public.message_device_copies FOR SELECT
  USING (
    auth.uid() = recipient_user_id
    AND EXISTS (
      SELECT 1
      FROM public.messages m
      WHERE m.id = public.message_device_copies.message_id
        AND m.sender_id = public.message_device_copies.sender_user_id
    )
  );

CREATE POLICY "Sender can read copies they sent"
  ON public.message_device_copies FOR SELECT
  USING (
    auth.uid() = sender_user_id
    AND EXISTS (
      SELECT 1
      FROM public.messages m
      WHERE m.id = public.message_device_copies.message_id
        AND m.sender_id = public.message_device_copies.sender_user_id
    )
  );

CREATE POLICY "Sender can insert device copies"
  ON public.message_device_copies FOR INSERT
  WITH CHECK (
    auth.uid() = sender_user_id
    AND EXISTS (
      SELECT 1
      FROM public.messages m
      JOIN public.conversation_participants sender_participant
        ON sender_participant.conversation_id = m.conversation_id
       AND sender_participant.user_id = public.message_device_copies.sender_user_id
      JOIN public.conversation_participants recipient_participant
        ON recipient_participant.conversation_id = m.conversation_id
       AND recipient_participant.user_id = public.message_device_copies.recipient_user_id
      JOIN public.user_devices recipient_device
        ON recipient_device.user_id = public.message_device_copies.recipient_user_id
       AND recipient_device.device_id = public.message_device_copies.recipient_device_id
       AND recipient_device.is_active = true
      WHERE m.id = public.message_device_copies.message_id
        AND m.sender_id = public.message_device_copies.sender_user_id
    )
  );

CREATE POLICY "Recipient can mark delivered/read"
  ON public.message_device_copies FOR UPDATE
  USING (
    auth.uid() = recipient_user_id
    AND EXISTS (
      SELECT 1
      FROM public.messages m
      WHERE m.id = public.message_device_copies.message_id
        AND m.sender_id = public.message_device_copies.sender_user_id
    )
  )
  WITH CHECK (
    auth.uid() = recipient_user_id
    AND EXISTS (
      SELECT 1
      FROM public.messages m
      WHERE m.id = public.message_device_copies.message_id
        AND m.sender_id = public.message_device_copies.sender_user_id
    )
  );

DROP FUNCTION IF EXISTS public.get_device_copy_for_message(uuid, text);

CREATE FUNCTION public.get_device_copy_for_message(
  p_message_id uuid,
  p_device_id text
)
RETURNS TABLE (
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
  SELECT
    mdc.encrypted_body,
    mdc.sender_user_id,
    mdc.sender_device_id,
    mdc.recipient_device_id,
    mdc.created_at
  FROM public.message_device_copies mdc
  JOIN public.messages m ON m.id = mdc.message_id
  WHERE mdc.message_id = p_message_id
    AND mdc.recipient_device_id = p_device_id
    AND mdc.recipient_user_id = auth.uid()
    AND m.sender_id = mdc.sender_user_id
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_device_copy_for_message(uuid, text) TO authenticated;

DROP FUNCTION IF EXISTS public.get_device_copies_for_user(uuid);

CREATE FUNCTION public.get_device_copies_for_user(p_message_id uuid)
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
  SELECT
    mdc.encrypted_body,
    mdc.sender_user_id,
    mdc.sender_device_id,
    mdc.recipient_device_id,
    mdc.created_at
  FROM public.message_device_copies mdc
  JOIN public.messages m ON m.id = mdc.message_id
  WHERE mdc.message_id = p_message_id
    AND mdc.recipient_user_id = auth.uid()
    AND m.sender_id = mdc.sender_user_id
  ORDER BY mdc.created_at ASC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_device_copies_for_user(uuid) TO authenticated;
