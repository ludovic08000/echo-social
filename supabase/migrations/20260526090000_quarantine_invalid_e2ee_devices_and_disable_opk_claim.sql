-- Quarantine invalid E2EE devices and keep them out of authenticated fan-out.
-- New traffic must only target devices whose lifecycle and signed prekey verify.

CREATE TABLE IF NOT EXISTS public.invalid_e2ee_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NULL,
  device_id text NOT NULL,
  reason text NOT NULL DEFAULT 'invalid_spk_signature',
  invalidated_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invalid_e2ee_devices_user_device
  ON public.invalid_e2ee_devices (user_id, device_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invalid_e2ee_devices_global_device
  ON public.invalid_e2ee_devices (device_id)
  WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_invalid_e2ee_devices_lookup
  ON public.invalid_e2ee_devices (device_id, user_id, expires_at);

ALTER TABLE public.invalid_e2ee_devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners can read invalid e2ee devices" ON public.invalid_e2ee_devices;
CREATE POLICY "Owners can read invalid e2ee devices"
  ON public.invalid_e2ee_devices
  FOR SELECT
  TO authenticated
  USING (user_id IS NULL OR auth.uid() = user_id);

DROP POLICY IF EXISTS "Service role manages invalid e2ee devices" ON public.invalid_e2ee_devices;
CREATE POLICY "Service role manages invalid e2ee devices"
  ON public.invalid_e2ee_devices
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

INSERT INTO public.invalid_e2ee_devices (user_id, device_id, reason)
VALUES
  (NULL, '84aaa52143235807214bf3aa161dd03a', 'known_invalid_device_quarantine'),
  (NULL, '6508eb47a200893f49720fe84b9290b3', 'known_invalid_device_quarantine'),
  (NULL, '9da8c742a4fe81d1d9ce6c0ffb4e055b', 'known_invalid_device_quarantine'),
  (NULL, '75e575fcbfaa8066bcbc9105fc5f4ac8', 'known_invalid_device_quarantine'),
  (NULL, 'c6601674b0f700f28c9f2956774eca97', 'known_invalid_device_quarantine'),
  (NULL, '52adb13ff236ae5c833c9d9049c0df71', 'known_invalid_device_quarantine'),
  (NULL, 'b166de502d729356dcbd6c0b5b1a39b0', 'known_invalid_device_quarantine'),
  (NULL, '49cfdeab59355de3051925b4f09fba75', 'known_invalid_device_quarantine'),
  (NULL, '92585130870cedf210af1019379dbc61', 'known_invalid_device_quarantine'),
  (NULL, '450c0cd9af35813c8a99ec5bc0f39ab8', 'known_invalid_device_quarantine')
ON CONFLICT DO NOTHING;

UPDATE public.user_devices d
SET
  is_active = false,
  stale_at = COALESCE(d.stale_at, now()),
  revoked_at = COALESCE(d.revoked_at, now()),
  revoke_reason = COALESCE(d.revoke_reason, 'known_invalid_device_quarantine'),
  crypto_invalid_at = COALESCE(d.crypto_invalid_at, now()),
  crypto_invalid_reason = COALESCE(d.crypto_invalid_reason, 'known_invalid_device_quarantine'),
  prekey_repair_requested_at = COALESCE(d.prekey_repair_requested_at, now()),
  updated_at = now()
WHERE d.device_id IN (
  '84aaa52143235807214bf3aa161dd03a',
  '6508eb47a200893f49720fe84b9290b3',
  '9da8c742a4fe81d1d9ce6c0ffb4e055b',
  '75e575fcbfaa8066bcbc9105fc5f4ac8',
  'c6601674b0f700f28c9f2956774eca97',
  '52adb13ff236ae5c833c9d9049c0df71',
  'b166de502d729356dcbd6c0b5b1a39b0',
  '49cfdeab59355de3051925b4f09fba75',
  '92585130870cedf210af1019379dbc61',
  '450c0cd9af35813c8a99ec5bc0f39ab8'
);

UPDATE public.device_signed_prekeys sp
SET
  is_active = false,
  expires_at = LEAST(sp.expires_at, now())
WHERE sp.device_id IN (
  '84aaa52143235807214bf3aa161dd03a',
  '6508eb47a200893f49720fe84b9290b3',
  '9da8c742a4fe81d1d9ce6c0ffb4e055b',
  '75e575fcbfaa8066bcbc9105fc5f4ac8',
  'c6601674b0f700f28c9f2956774eca97',
  '52adb13ff236ae5c833c9d9049c0df71',
  'b166de502d729356dcbd6c0b5b1a39b0',
  '49cfdeab59355de3051925b4f09fba75',
  '92585130870cedf210af1019379dbc61',
  '450c0cd9af35813c8a99ec5bc0f39ab8'
);

DELETE FROM public.device_one_time_prekeys opk
WHERE opk.device_id IN (
  '84aaa52143235807214bf3aa161dd03a',
  '6508eb47a200893f49720fe84b9290b3',
  '9da8c742a4fe81d1d9ce6c0ffb4e055b',
  '75e575fcbfaa8066bcbc9105fc5f4ac8',
  'c6601674b0f700f28c9f2956774eca97',
  '52adb13ff236ae5c833c9d9049c0df71',
  'b166de502d729356dcbd6c0b5b1a39b0',
  '49cfdeab59355de3051925b4f09fba75',
  '92585130870cedf210af1019379dbc61',
  '450c0cd9af35813c8a99ec5bc0f39ab8'
);

CREATE OR REPLACE FUNCTION public.is_invalid_e2ee_device(
  p_user_id uuid,
  p_device_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.invalid_e2ee_devices bad
    WHERE bad.device_id = trim(p_device_id)
      AND (bad.user_id IS NULL OR bad.user_id = p_user_id)
      AND (bad.expires_at IS NULL OR bad.expires_at > now())
  )
  OR EXISTS (
    SELECT 1
    FROM public.user_devices d
    WHERE d.user_id = p_user_id
      AND d.device_id = trim(p_device_id)
      AND (
        d.is_active = false
        OR d.revoked_at IS NOT NULL
        OR d.stale_at IS NOT NULL
        OR d.crypto_invalid_at IS NOT NULL
      )
  );
$function$;

GRANT EXECUTE ON FUNCTION public.is_invalid_e2ee_device(uuid, text)
  TO authenticated;

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

  INSERT INTO public.invalid_e2ee_devices (user_id, device_id, reason, expires_at)
  VALUES (p_user_id, trim(p_device_id), v_reason, now() + interval '15 minutes')
  ON CONFLICT (user_id, device_id) WHERE user_id IS NOT NULL
  DO UPDATE SET
    reason = EXCLUDED.reason,
    invalidated_at = now(),
    expires_at = EXCLUDED.expires_at;

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

  IF EXISTS (
    SELECT 1 FROM public.invalid_e2ee_devices bad
    WHERE bad.user_id IS NULL
      AND bad.device_id = trim(p_device_id)
  ) THEN
    RAISE EXCEPTION 'USER_DEVICES_REACTIVATION_BLOCKED';
  END IF;

  DELETE FROM public.invalid_e2ee_devices bad
  WHERE bad.user_id = p_user_id
    AND bad.device_id = trim(p_device_id);

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
    AND NOT public.is_invalid_e2ee_device(d.user_id, d.device_id)
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
    AND sp.device_id = trim(p_device_id)
    AND sp.is_active = true
    AND sp.expires_at > now()
    AND d.is_active = true
    AND d.revoked_at IS NULL
    AND d.stale_at IS NULL
    AND NOT public.is_invalid_e2ee_device(d.user_id, d.device_id)
    AND d.last_seen_at > now() - interval '45 days'
  ORDER BY sp.keys_epoch DESC, sp.created_at DESC
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_device_prekey_bundle(uuid, text)
  TO authenticated;

DROP FUNCTION IF EXISTS public.claim_device_one_time_prekey(uuid, text);

CREATE FUNCTION public.claim_device_one_time_prekey(
  p_user_id uuid,
  p_device_id text
)
RETURNS TABLE (
  opk_id integer,
  public_key text
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
  -- OPK claiming is temporarily disabled while invalid/stale device recovery is hardened.
  -- Initiators still perform authenticated X3DH with the device SPK, without an opkId.
  SELECT NULL::integer AS opk_id, NULL::text AS public_key
  WHERE false;
$function$;

GRANT EXECUTE ON FUNCTION public.claim_device_one_time_prekey(uuid, text)
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
       AND NOT public.is_invalid_e2ee_device(recipient_device.user_id, recipient_device.device_id)
       AND recipient_device.last_seen_at > now() - interval '45 days'
      WHERE m.id = public.message_device_copies.message_id
        AND m.sender_id = public.message_device_copies.sender_user_id
    )
  );
