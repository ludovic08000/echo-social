CREATE OR REPLACE FUNCTION public.verify_own_key_consistency(p_device_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_identity record;
  v_device record;
  v_spk_count int := 0;
  v_opk_count int := 0;
  v_list record;
  v_issues text[] := ARRAY[]::text[];
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  -- Invariant vérifié : identité de compte active unique et publiée.
  SELECT id, fingerprint, created_at, updated_at
    INTO v_identity
    FROM public.user_public_keys
   WHERE user_id = v_user AND is_active = true
   ORDER BY created_at DESC
   LIMIT 1;

  IF v_identity IS NULL THEN
    v_issues := v_issues || 'missing_active_identity';
  END IF;

  SELECT device_id, is_active, revoked_at, crypto_invalid_at,
         device_signing_key, device_authorization_signature, updated_at
    INTO v_device
    FROM public.user_devices
   WHERE user_id = v_user AND device_id = p_device_id
   LIMIT 1;

  IF v_device IS NULL THEN
    v_issues := v_issues || 'device_not_registered';
  ELSE
    IF v_device.is_active IS NOT TRUE OR v_device.revoked_at IS NOT NULL THEN
      v_issues := v_issues || 'device_inactive';
    END IF;
    IF v_device.crypto_invalid_at IS NOT NULL THEN
      v_issues := v_issues || 'device_crypto_invalid';
    END IF;
    IF v_device.device_signing_key IS NULL THEN
      v_issues := v_issues || 'missing_device_signing_key';
    END IF;
    IF v_device.device_authorization_signature IS NULL THEN
      v_issues := v_issues || 'missing_device_authorization';
    ELSIF v_identity IS NOT NULL
      AND v_device.updated_at IS NOT NULL
      AND v_identity.created_at > v_device.updated_at THEN
      -- Autorisation signée avant l'identité active : elle ne vérifie plus.
      v_issues := v_issues || 'stale_device_authorization';
    END IF;
  END IF;

  SELECT count(*) INTO v_spk_count
    FROM public.device_signed_prekeys
   WHERE user_id = v_user AND device_id = p_device_id
     AND is_active = true
     AND (expires_at IS NULL OR expires_at > now());
  IF v_spk_count = 0 THEN
    v_issues := v_issues || 'missing_signed_prekey';
  END IF;

  SELECT count(*) INTO v_opk_count
    FROM public.device_one_time_prekeys
   WHERE user_id = v_user AND device_id = p_device_id;
  IF v_opk_count < 25 THEN
    v_issues := v_issues || 'low_one_time_prekeys';
  END IF;

  SELECT device_ids, list_version INTO v_list
    FROM public.signed_device_lists
   WHERE user_id = v_user
   LIMIT 1;

  IF v_list IS NULL THEN
    v_issues := v_issues || 'missing_signed_device_list';
  ELSIF NOT (p_device_id = ANY (v_list.device_ids)) THEN
    v_issues := v_issues || 'device_absent_from_signed_list';
  END IF;

  RETURN jsonb_build_object(
    'ok', cardinality(v_issues) = 0,
    'checked_at', now(),
    'device_id', p_device_id,
    'identity_fingerprint', v_identity.fingerprint,
    'identity_created_at', v_identity.created_at,
    'signed_prekeys', v_spk_count,
    'one_time_prekeys', v_opk_count,
    'signed_list_version', v_list.list_version,
    'issues', to_jsonb(v_issues)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_own_key_consistency(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_own_key_consistency(text) TO authenticated;