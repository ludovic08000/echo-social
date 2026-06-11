-- Sesame-style stale device lifecycle.
--
-- 30 days: mark inactive devices as stale for UI/diagnostics.
-- 45 days: stop returning them for new fan-out/X3DH bundles.
-- 90 days: revoke them automatically while keeping rows for audit/history.

ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS stale_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS revoked_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS revoke_reason text;

CREATE INDEX IF NOT EXISTS idx_user_devices_lifecycle
  ON public.user_devices (user_id, is_active, revoked_at, last_seen_at DESC);

CREATE OR REPLACE FUNCTION public.guard_user_device_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revoke_reason = 'manual'
       AND OLD.revoked_at IS NOT NULL
       AND COALESCE(NEW.is_active, false) = true THEN
      RAISE EXCEPTION 'Device was manually revoked';
    END IF;

    -- A system-stale device may come back by proving it still has the same
    -- authenticated account + device id. Clear lifecycle marks when it
    -- publishes a fresh heartbeat. Manual revocation stays blocked above.
    IF COALESCE(NEW.is_active, false) = true
       AND COALESCE(OLD.revoke_reason, '') <> 'manual'
       AND NEW.last_seen_at > COALESCE(OLD.last_seen_at, timestamp with time zone 'epoch') THEN
      NEW.stale_at := NULL;
      NEW.revoked_at := NULL;
      NEW.revoke_reason := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_guard_user_device_lifecycle ON public.user_devices;
CREATE TRIGGER trg_guard_user_device_lifecycle
  BEFORE UPDATE ON public.user_devices
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_user_device_lifecycle();

DROP FUNCTION IF EXISTS public.cleanup_stale_user_devices(interval, interval);

CREATE FUNCTION public.cleanup_stale_user_devices(
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
DECLARE
  v_user uuid := auth.uid();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  RETURN QUERY
  WITH marked AS (
    UPDATE public.user_devices d
    SET
      stale_at = COALESCE(d.stale_at, now()),
      updated_at = now()
    WHERE d.user_id = v_user
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
    WHERE d.user_id = v_user
      AND d.is_active = true
      AND d.last_seen_at <= now() - p_revoke_after
      AND COALESCE(d.revoke_reason, '') <> 'manual'
    RETURNING d.device_id
  )
  SELECT revoked.device_id, 'revoked'::text
  FROM revoked;
END;
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
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT d.device_id, d.device_public_key, d.last_seen_at
  FROM public.user_devices d
  WHERE d.user_id = p_user_id
    AND d.is_active = true
    AND d.revoked_at IS NULL
    AND d.last_seen_at > now() - interval '45 days'
    AND d.device_public_key IS NOT NULL
    AND length(trim(d.device_public_key)) > 0
  ORDER BY d.last_seen_at DESC;
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
  device_public_key text
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
    d.device_public_key
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
    AND d.last_seen_at > now() - interval '45 days'
  ORDER BY sp.created_at DESC
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
       AND recipient_device.last_seen_at > now() - interval '45 days'
      WHERE m.id = public.message_device_copies.message_id
        AND m.sender_id = public.message_device_copies.sender_user_id
    )
  );
