-- Active lifecycle for devices with invalid signed prekeys.
--
-- A client that detects an invalid device SPK should not keep faning out to it.
-- The client keeps a local TTL cache; this server-side marker lets the owner
-- repair its own device and lets list/prekey RPCs temporarily hide bad bundles.

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS crypto_invalid_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS crypto_invalid_reason text,
  ADD COLUMN IF NOT EXISTS prekey_repair_requested_at timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_user_devices_crypto_invalid
  ON public.user_devices (user_id, crypto_invalid_at)
  WHERE crypto_invalid_at IS NOT NULL;

DROP FUNCTION IF EXISTS public.request_device_prekey_repair(uuid, text, text);

CREATE FUNCTION public.request_device_prekey_repair(
  p_user_id uuid,
  p_device_id text,
  p_reason text DEFAULT 'invalid_spk_signature'
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_requester uuid := auth.uid();
  v_reason text := left(coalesce(nullif(trim(p_reason), ''), 'invalid_spk_signature'), 120);
BEGIN
  IF v_requester IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_user_id IS NULL OR p_device_id IS NULL OR length(trim(p_device_id)) = 0 THEN
    RAISE EXCEPTION 'Invalid device';
  END IF;

  IF v_requester <> p_user_id AND NOT EXISTS (
    SELECT 1
    FROM public.conversation_participants requester_participant
    JOIN public.conversation_participants target_participant
      ON target_participant.conversation_id = requester_participant.conversation_id
    WHERE requester_participant.user_id = v_requester
      AND target_participant.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'Device repair request not allowed';
  END IF;

  UPDATE public.user_devices d
  SET
    crypto_invalid_at = now(),
    crypto_invalid_reason = v_reason,
    prekey_repair_requested_at = now(),
    updated_at = now()
  WHERE d.user_id = p_user_id
    AND d.device_id = trim(p_device_id)
    AND d.is_active = true
    AND d.revoked_at IS NULL;

  RETURN FOUND;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.request_device_prekey_repair(uuid, text, text)
  TO authenticated;

DROP FUNCTION IF EXISTS public.clear_device_prekey_repair_needed(uuid, text);

CREATE FUNCTION public.clear_device_prekey_repair_needed(
  p_user_id uuid,
  p_device_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Device repair clear not allowed';
  END IF;

  UPDATE public.user_devices d
  SET
    is_active = true,
    stale_at = NULL,
    revoked_at = NULL,
    revoke_reason = NULL,
    crypto_invalid_at = NULL,
    crypto_invalid_reason = NULL,
    prekey_repair_requested_at = NULL,
    last_seen_at = now(),
    updated_at = now()
  WHERE d.user_id = p_user_id
    AND d.device_id = trim(p_device_id)
    AND COALESCE(d.revoke_reason, '') <> 'manual';

  RETURN FOUND;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.clear_device_prekey_repair_needed(uuid, text)
  TO authenticated;

DROP FUNCTION IF EXISTS public.list_active_devices_for_user(uuid);

CREATE FUNCTION public.list_active_devices_for_user(p_user_id uuid)
RETURNS TABLE (
  device_id text,
  device_public_key text,
  last_seen_at timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.cleanup_stale_user_devices_for_user(p_user_id);

  RETURN QUERY
  SELECT d.device_id, d.device_public_key, d.last_seen_at
  FROM public.user_devices d
  WHERE d.user_id = p_user_id
    AND d.is_active = true
    AND d.revoked_at IS NULL
    AND d.stale_at IS NULL
    AND (
      d.crypto_invalid_at IS NULL
      OR d.crypto_invalid_at < now() - interval '15 minutes'
    )
    AND d.last_seen_at > now() - interval '45 days'
    AND d.device_public_key IS NOT NULL
    AND length(trim(d.device_public_key)) > 0
  ORDER BY d.last_seen_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.list_active_devices_for_user(uuid)
  TO authenticated;

DROP FUNCTION IF EXISTS public.get_device_prekey_bundle(uuid, text);

CREATE FUNCTION public.get_device_prekey_bundle(
  p_user_id uuid,
  p_device_id text
)
RETURNS TABLE (
  spk_id integer,
  public_key text,
  signature text,
  device_public_key text,
  keys_epoch integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT
    sp.spk_id,
    sp.public_key,
    sp.signature,
    d.device_public_key,
    sp.keys_epoch
  FROM public.device_signed_prekeys sp
  JOIN public.user_devices d
    ON d.user_id = sp.user_id
   AND d.device_id = sp.device_id
  WHERE sp.user_id = p_user_id
    AND sp.device_id = p_device_id
    AND sp.is_active = true
    AND sp.expires_at > now()
    AND d.is_active = true
    AND d.revoked_at IS NULL
    AND d.stale_at IS NULL
    AND (
      d.crypto_invalid_at IS NULL
      OR d.crypto_invalid_at < now() - interval '15 minutes'
    )
    AND d.last_seen_at > now() - interval '45 days'
  ORDER BY sp.keys_epoch DESC, sp.created_at DESC
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_device_prekey_bundle(uuid, text)
  TO authenticated;

DROP POLICY IF EXISTS "Sender can insert device copies" ON public.message_device_copies;

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
       AND recipient_device.revoked_at IS NULL
       AND recipient_device.stale_at IS NULL
       AND (
         recipient_device.crypto_invalid_at IS NULL
         OR recipient_device.crypto_invalid_at < now() - interval '15 minutes'
       )
       AND recipient_device.last_seen_at > now() - interval '45 days'
      WHERE m.id = public.message_device_copies.message_id
        AND m.sender_id = public.message_device_copies.sender_user_id
    )
  );
