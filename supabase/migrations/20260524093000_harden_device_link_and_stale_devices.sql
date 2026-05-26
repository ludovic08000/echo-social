-- Harden linked-device approval and stale-device fan-out.
--
-- Client-side QR key binding prevents a mutated server row from swapping the
-- requester public key. These server guards make sure only fresh, active
-- devices can approve a link and stale devices stop receiving new bundles.

CREATE OR REPLACE FUNCTION public.cleanup_stale_user_devices_for_user(
  p_user_id uuid,
  p_stale_after interval DEFAULT interval '30 days',
  p_revoke_after interval DEFAULT interval '90 days'
)
RETURNS TABLE (
  device_id text,
  action text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  RETURN QUERY
  WITH marked AS (
    UPDATE public.user_devices d
    SET
      stale_at = COALESCE(d.stale_at, now()),
      updated_at = now()
    WHERE d.user_id = p_user_id
      AND d.is_active = true
      AND d.revoked_at IS NULL
      AND d.last_seen_at <= now() - p_stale_after
      AND d.stale_at IS NULL
    RETURNING d.device_id
  )
  SELECT marked.device_id, 'stale'::text
  FROM marked;

  RETURN QUERY
  WITH revoked AS (
    UPDATE public.user_devices d
    SET
      is_active = false,
      revoked_at = COALESCE(d.revoked_at, now()),
      revoke_reason = COALESCE(d.revoke_reason, 'inactive_90d'),
      updated_at = now()
    WHERE d.user_id = p_user_id
      AND d.is_active = true
      AND d.last_seen_at <= now() - p_revoke_after
      AND COALESCE(d.revoke_reason, '') <> 'manual'
    RETURNING d.device_id
  )
  SELECT revoked.device_id, 'revoked'::text
  FROM revoked;
END;
$function$;

REVOKE ALL ON FUNCTION public.cleanup_stale_user_devices_for_user(uuid, interval, interval)
  FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.cleanup_stale_user_devices(
  p_stale_after interval DEFAULT interval '30 days',
  p_revoke_after interval DEFAULT interval '90 days'
)
RETURNS TABLE (
  device_id text,
  action text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT *
  FROM public.cleanup_stale_user_devices_for_user(auth.uid(), p_stale_after, p_revoke_after);
$function$;

GRANT EXECUTE ON FUNCTION public.cleanup_stale_user_devices(interval, interval)
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
    AND d.last_seen_at > now() - interval '45 days'
  ORDER BY sp.keys_epoch DESC, sp.created_at DESC
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_device_prekey_bundle(uuid, text)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.approve_device_link_request(
  p_token_hash text,
  p_approver_device_id text,
  p_encrypted_payload text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_id uuid;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_approver_device_id IS NULL OR length(trim(p_approver_device_id)) < 8 THEN
    RAISE EXCEPTION 'Invalid approver device';
  END IF;

  IF p_encrypted_payload IS NULL OR length(p_encrypted_payload) < 32 THEN
    RAISE EXCEPTION 'Missing encrypted payload';
  END IF;

  IF length(p_encrypted_payload) > 2097152 THEN
    RAISE EXCEPTION 'Encrypted payload too large';
  END IF;

  PERFORM public.cleanup_stale_user_devices_for_user(v_user);

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_devices d
    WHERE d.user_id = v_user
      AND d.device_id = trim(p_approver_device_id)
      AND d.is_active = true
      AND d.revoked_at IS NULL
      AND d.stale_at IS NULL
      AND d.last_seen_at > now() - interval '45 days'
  ) THEN
    RAISE EXCEPTION 'Approver device is not active';
  END IF;

  UPDATE public.device_link_requests r
  SET
    approver_device_id = trim(p_approver_device_id),
    encrypted_payload = p_encrypted_payload,
    status = 'approved',
    approved_at = now(),
    updated_at = now()
  WHERE r.user_id = v_user
    AND r.token_hash = trim(p_token_hash)
    AND r.status = 'pending'
    AND r.expires_at > now()
    AND r.requester_device_id <> trim(p_approver_device_id)
  RETURNING r.id INTO v_id;

  RETURN v_id IS NOT NULL;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.approve_device_link_request(text, text, text)
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
       AND recipient_device.last_seen_at > now() - interval '45 days'
      WHERE m.id = public.message_device_copies.message_id
        AND m.sender_id = public.message_device_copies.sender_user_id
    )
  );
