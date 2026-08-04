CREATE OR REPLACE FUNCTION public.register_user_device_safe(
  p_user_id uuid,
  p_device_id text,
  p_device_name text,
  p_device_public_key text,
  p_device_fingerprint text,
  p_platform text,
  p_user_agent text,
  p_device_signing_key text,
  p_device_authorization_signature text,
  p_account_identity_key text,
  p_account_signing_key text,
  p_account_fingerprint text,
  p_account_binding_signature text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_existing_device public.user_devices%rowtype;
  v_existing_account public.user_public_keys%rowtype;
  v_now timestamptz := now();
BEGIN
  IF v_uid IS NULL OR p_user_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  END IF;
  IF length(v_device_id) < 8
     OR length(trim(coalesce(p_device_public_key, ''))) < 40
     OR length(trim(coalesce(p_device_signing_key, ''))) < 40
     OR length(trim(coalesce(p_device_authorization_signature, ''))) < 80
     OR length(trim(coalesce(p_account_identity_key, ''))) < 40
     OR length(trim(coalesce(p_account_signing_key, ''))) < 40
     OR length(trim(coalesce(p_account_fingerprint, ''))) < 32
     OR length(trim(coalesce(p_account_binding_signature, ''))) < 80 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_AUTHORIZATION');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  -- Invariant corrigé : une seule identité courante participe à l'autorisation ;
  -- les identités archivées restent conservées mais ne doivent jamais bloquer la route.
  SELECT * INTO v_existing_account
  FROM public.user_public_keys
  WHERE user_id = v_uid
    AND is_active = true
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF found THEN
    IF v_existing_account.identity_key IS DISTINCT FROM p_account_identity_key
       OR v_existing_account.signing_key IS DISTINCT FROM p_account_signing_key
       OR v_existing_account.fingerprint IS DISTINCT FROM p_account_fingerprint
       OR v_existing_account.identity_binding_signature IS DISTINCT FROM p_account_binding_signature
       OR v_existing_account.identity_binding_version IS DISTINCT FROM 1 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ACCOUNT_IDENTITY_MISMATCH');
    END IF;
    UPDATE public.user_public_keys
    SET updated_at = v_now
    WHERE id = v_existing_account.id;
  ELSE
    INSERT INTO public.user_public_keys (
      user_id, identity_key, signing_key, fingerprint, kem_type,
      identity_binding_version, identity_binding_signature,
      is_active, created_at, updated_at
    ) VALUES (
      v_uid, p_account_identity_key, p_account_signing_key,
      p_account_fingerprint, 'X25519', 1, p_account_binding_signature,
      true, v_now, v_now
    );
  END IF;

  SELECT * INTO v_existing_device
  FROM public.user_devices
  WHERE user_id = v_uid AND device_id = v_device_id
  FOR UPDATE;

  IF found AND (
    v_existing_device.revoked_at IS NOT NULL
    OR v_existing_device.approval_status = 'rejected'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED_OR_REJECTED');
  END IF;
  IF found AND (
    v_existing_device.device_public_key IS DISTINCT FROM p_device_public_key
    OR (
      v_existing_device.device_signing_key IS NOT NULL
      AND v_existing_device.device_signing_key IS DISTINCT FROM p_device_signing_key
    )
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DEVICE_IDENTITY_MISMATCH');
  END IF;

  INSERT INTO public.user_devices (
    user_id, device_id, device_name, device_public_key,
    device_signing_key, device_authorization_signature,
    device_fingerprint, platform, user_agent, is_active, last_seen_at,
    approval_status, approval_requested_at, approved_at, approved_by,
    stale_at, routing_status, routing_error, routing_checked_at
  ) VALUES (
    v_uid, v_device_id, p_device_name, p_device_public_key,
    p_device_signing_key, p_device_authorization_signature,
    p_device_fingerprint, p_platform, p_user_agent, true, v_now,
    'approved', v_now, v_now, v_uid,
    null, 'repairing', 'SIGNED_PREKEY_VALIDATION_PENDING', v_now
  )
  ON CONFLICT (user_id, device_id) DO UPDATE
  SET device_name = excluded.device_name,
      device_fingerprint = excluded.device_fingerprint,
      platform = excluded.platform,
      user_agent = excluded.user_agent,
      last_seen_at = v_now,
      updated_at = v_now,
      is_active = true,
      approval_status = 'approved',
      approved_at = coalesce(public.user_devices.approved_at, v_now),
      approved_by = coalesce(public.user_devices.approved_by, v_uid),
      stale_at = null,
      device_signing_key = excluded.device_signing_key,
      device_authorization_signature = excluded.device_authorization_signature,
      routing_status = CASE
        WHEN EXISTS (
          SELECT 1 FROM public.device_signed_prekeys spk
          WHERE spk.user_id = v_uid
            AND spk.device_id = v_device_id
            AND spk.is_active = true
            AND (spk.expires_at IS NULL OR spk.expires_at > v_now)
        ) THEN 'ready' ELSE 'repairing' END,
      routing_error = CASE
        WHEN EXISTS (
          SELECT 1 FROM public.device_signed_prekeys spk
          WHERE spk.user_id = v_uid
            AND spk.device_id = v_device_id
            AND spk.is_active = true
            AND (spk.expires_at IS NULL OR spk.expires_at > v_now)
        ) THEN null ELSE 'SIGNED_PREKEY_VALIDATION_PENDING' END,
      routing_checked_at = v_now
  WHERE public.user_devices.revoked_at IS NULL
    AND coalesce(public.user_devices.approval_status, 'approved') <> 'rejected';

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_AUTHORIZED',
    'device_id', v_device_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_user_device_safe(
  uuid,text,text,text,text,text,text,text,text,text,text,text,text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_user_device_safe(
  uuid,text,text,text,text,text,text,text,text,text,text,text,text
) TO authenticated;