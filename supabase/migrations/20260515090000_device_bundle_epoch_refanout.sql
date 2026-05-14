-- Multi-device E2EE bundle epochs + explicit message re-fanout request.
--
-- Epochs let clients invalidate cached device bundles whenever a device
-- regenerates SPK or OPK material. Re-fanout is an alias over the existing
-- device-copy retry table; plaintext never reaches Supabase.

ALTER TABLE public.device_signed_prekeys
  ADD COLUMN IF NOT EXISTS keys_epoch integer NOT NULL DEFAULT 1;

UPDATE public.device_signed_prekeys
SET keys_epoch = greatest(keys_epoch, spk_id)
WHERE keys_epoch < spk_id;

CREATE OR REPLACE FUNCTION public.bump_device_keys_epoch(
  p_user_id uuid,
  p_device_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_epoch integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'Device epoch update not allowed';
  END IF;

  UPDATE public.device_signed_prekeys
  SET keys_epoch = greatest(keys_epoch + 1, spk_id + 1)
  WHERE user_id = p_user_id
    AND device_id = p_device_id
    AND is_active = true
  RETURNING keys_epoch INTO v_epoch;

  RETURN coalesce(v_epoch, 0);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.bump_device_keys_epoch(uuid, text)
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
    AND d.last_seen_at > now() - interval '45 days'
  ORDER BY sp.keys_epoch DESC, sp.created_at DESC
  LIMIT 1;
$function$;

GRANT EXECUTE ON FUNCTION public.get_device_prekey_bundle(uuid, text)
  TO authenticated;

DROP FUNCTION IF EXISTS public.request_message_refanout(uuid, uuid, text);

CREATE FUNCTION public.request_message_refanout(
  p_message_id uuid,
  p_sender_user_id uuid,
  p_requester_device_id text
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.request_device_copy_retry(
    p_message_id,
    p_sender_user_id,
    p_requester_device_id
  );
$function$;

GRANT EXECUTE ON FUNCTION public.request_message_refanout(uuid, uuid, text)
  TO authenticated;
