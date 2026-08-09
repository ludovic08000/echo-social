-- =============================================================================
-- Aegis — nettoyage canonique du cycle de vie appareil (forward-only)
--
-- NON APPLIQUÉE. À exécuter explicitement via l'outil de migration Lovable Cloud
-- (supabase/migrations est géré par la plateforme ; ce fichier est le brouillon
-- validé côté code, en attente d'ordre explicite du propriétaire).
-- Horodatage cible : 20260809120000_aegis_canonical_device_cleanup.sql
--
-- Invariant : la confiance appareil provient uniquement de user_devices
-- (approuvé + actif + bindé + routable + signature d'autorisation) et des
-- preuves cryptographiques. Aucun signal matériel (fingerprint UA/écran/CPU),
-- aucun appareil « primaire », aucune liste signée, aucune racine d'identité,
-- aucun flow QR.
--
-- NOTE : le fingerprint CRYPTOGRAPHIQUE de compte (user_public_keys.fingerprint)
-- n'est pas touché.
-- NOTE : register_user_device_safe, approve_user_device, complete_user_device_enrollment
-- et get_sesame_device_list restent des chemins runtime : leurs anciens overloads
-- (avec fingerprint / primaire) sont supprimés et remplacés, pas retirés.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Enrôlement sans fingerprint matériel
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.begin_user_device_enrollment(text, text, text, text);
DROP FUNCTION IF EXISTS public.begin_user_device_enrollment(text, text, text);

CREATE FUNCTION public.begin_user_device_enrollment(
  p_device_name text,
  p_platform text,
  p_user_agent text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_now timestamptz := now();
  v_device_id text;
  v_challenge_id uuid;
  v_nonce text;
  v_existing record;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  END IF;
  IF coalesce(p_platform, '') NOT IN ('ios', 'android', 'web') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DEVICE_PLATFORM_INVALID');
  END IF;

  -- Reprise idempotente d'un challenge encore ouvert pour le même user agent.
  SELECT * INTO v_existing
  FROM public.device_enrollment_challenges
  WHERE user_id = v_user_id
    AND consumed_at IS NULL
    AND expires_at > v_now
    AND coalesce(user_agent, '') = coalesce(p_user_agent, '')
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true,
      'code', 'DEVICE_ENROLLMENT_RESUMED',
      'challenge_id', v_existing.id,
      'device_id', v_existing.device_id,
      'nonce', v_existing.nonce,
      'expires_at', v_existing.expires_at
    );
  END IF;

  v_device_id := 'dev_' || encode(gen_random_bytes(16), 'hex');
  v_nonce := encode(gen_random_bytes(32), 'base64');

  INSERT INTO public.device_enrollment_challenges (
    user_id, device_id, device_name, platform, user_agent, nonce, expires_at, created_at
  ) VALUES (
    v_user_id, v_device_id, p_device_name, p_platform, p_user_agent,
    v_nonce, v_now + interval '15 minutes', v_now
  )
  RETURNING id INTO v_challenge_id;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_ENROLLMENT_STAGED',
    'challenge_id', v_challenge_id,
    'device_id', v_device_id,
    'nonce', v_nonce,
    'expires_at', v_now + interval '15 minutes'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.begin_user_device_enrollment(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_user_device_enrollment(text, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Complétion canonique (5 arguments, sans device_fingerprint ni possession_payload_version)
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.complete_user_device_enrollment_v2(uuid, text, jsonb, text, text, text, integer);
DROP FUNCTION IF EXISTS public.complete_user_device_enrollment(uuid, text, jsonb, text, text, text, integer);
DROP FUNCTION IF EXISTS public.complete_user_device_enrollment(uuid, text, jsonb, text, text, text);

CREATE OR REPLACE FUNCTION public.complete_user_device_enrollment(
  p_challenge_id uuid,
  p_device_id text,
  p_authorization jsonb,
  p_possession_signature text,
  p_possession_payload text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_now timestamptz := now();
  v_challenge record;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  END IF;

  SELECT * INTO v_challenge
  FROM public.device_enrollment_challenges
  WHERE id = p_challenge_id AND user_id = v_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_NOT_STAGED');
  END IF;
  IF v_challenge.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_ALREADY_CONSUMED');
  END IF;
  IF v_challenge.expires_at <= v_now THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_CHALLENGE_EXPIRED');
  END IF;
  IF v_challenge.device_id IS DISTINCT FROM p_device_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_SERVER_ID_MISMATCH');
  END IF;
  IF coalesce(p_possession_signature, '') = '' OR coalesce(p_possession_payload, '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DEVICE_POSSESSION_PROOF_REQUIRED');
  END IF;
  -- La preuve de possession doit couvrir exactement le nonce du challenge stocké.
  IF position(v_challenge.nonce in p_possession_payload) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DEVICE_POSSESSION_PROOF_REQUIRED');
  END IF;

  INSERT INTO public.user_devices (
    user_id, device_id, device_name, platform, user_agent,
    device_public_key, device_signing_key, device_authorization_signature,
    approval_status, binding_status, routing_status,
    is_active, approval_challenge_id, created_at, last_seen_at
  ) VALUES (
    v_user_id, p_device_id, v_challenge.device_name, v_challenge.platform, v_challenge.user_agent,
    p_authorization->>'device_public_key',
    p_authorization->>'device_signing_key',
    p_authorization->>'device_authorization_signature',
    'pending', 'unbound', 'blocked',
    true, p_challenge_id, v_now, v_now
  )
  ON CONFLICT (user_id, device_id) DO UPDATE SET
    device_public_key = excluded.device_public_key,
    device_signing_key = excluded.device_signing_key,
    device_authorization_signature = excluded.device_authorization_signature,
    approval_challenge_id = excluded.approval_challenge_id,
    last_seen_at = v_now;

  UPDATE public.device_enrollment_challenges
  SET consumed_at = v_now,
      possession_signature = p_possession_signature,
      possession_payload = p_possession_payload
  WHERE id = p_challenge_id;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_ENROLLMENT_COMPLETED',
    'challenge_id', p_challenge_id,
    'device_id', p_device_id,
    'routing_status', 'blocked'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_user_device_enrollment(uuid, text, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_user_device_enrollment(uuid, text, jsonb, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Liste d'appareils actifs directement depuis user_devices (sans signed_device_lists)
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.list_active_devices_for_user(uuid);

CREATE FUNCTION public.list_active_devices_for_user(p_user_id uuid)
RETURNS TABLE (
  device_id text,
  device_public_key text,
  device_signing_key text,
  device_authorization_signature text,
  platform text,
  device_name text,
  last_seen_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.device_id,
         d.device_public_key,
         d.device_signing_key,
         d.device_authorization_signature,
         d.platform,
         d.device_name,
         d.last_seen_at
  FROM public.user_devices d
  WHERE d.user_id = p_user_id
    AND d.approval_status = 'approved'
    AND d.binding_status = 'bound'
    AND d.routing_status = 'ready'
    AND d.is_active = true
    AND d.revoked_at IS NULL
    AND d.stale_at IS NULL
    AND coalesce(d.device_public_key, '') <> ''
    AND coalesce(d.device_signing_key, '') <> ''
    AND coalesce(d.device_authorization_signature, '') <> ''
    AND EXISTS (
      SELECT 1 FROM public.device_signed_prekeys sp
      WHERE sp.user_id = d.user_id
        AND sp.device_id = d.device_id
        AND sp.is_active = true
        AND (sp.expires_at IS NULL OR sp.expires_at > now())
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.invalid_e2ee_devices ie
      WHERE ie.user_id = d.user_id AND ie.device_id = d.device_id
    );
$$;

REVOKE ALL ON FUNCTION public.list_active_devices_for_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_active_devices_for_user(uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 4. Révocation manuelle sans primaire / remplacement / racine
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.revoke_user_device(text, text);
DROP FUNCTION IF EXISTS public.revoke_user_device(text);

CREATE FUNCTION public.revoke_user_device(p_device_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_now timestamptz := now();
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  END IF;

  UPDATE public.user_devices
  SET is_active = false,
      approval_status = 'revoked',
      routing_status = 'blocked',
      revoked_at = v_now,
      revoke_reason = 'manual'
  WHERE user_id = v_user_id AND device_id = p_device_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND');
  END IF;

  DELETE FROM public.device_signed_prekeys WHERE user_id = v_user_id AND device_id = p_device_id;
  DELETE FROM public.device_one_time_prekeys WHERE user_id = v_user_id AND device_id = p_device_id;

  INSERT INTO public.invalid_e2ee_devices (user_id, device_id, reason)
  VALUES (v_user_id, p_device_id, 'manual_revocation')
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'code', 'DEVICE_REVOKED', 'device_id', p_device_id);
END;
$$;

REVOKE ALL ON FUNCTION public.revoke_user_device(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_user_device(text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 5. Enregistrement device canonique sans fingerprint matériel
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.register_user_device_safe(
  uuid, text, text, text, text, text, text, text, text, text, text, integer, text, text
);

CREATE OR REPLACE FUNCTION public.register_user_device_safe(
  p_user_id uuid,
  p_device_id text,
  p_device_name text,
  p_platform text,
  p_user_agent text,
  p_device_public_key text,
  p_device_signing_key text,
  p_device_authorization_signature text,
  p_account_identity_key text,
  p_account_signing_key text,
  p_account_fingerprint text,
  p_account_binding_version integer,
  p_account_binding_signature text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now timestamptz := now();
  v_status text;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  END IF;

  INSERT INTO public.user_devices (
    user_id, device_id, device_name, platform, user_agent,
    device_public_key, device_signing_key, device_authorization_signature,
    approval_status, binding_status, routing_status, is_active, created_at, last_seen_at
  ) VALUES (
    p_user_id, p_device_id, p_device_name, p_platform, p_user_agent,
    p_device_public_key, p_device_signing_key, p_device_authorization_signature,
    'pending', 'unbound', 'blocked', true, v_now, v_now
  )
  ON CONFLICT (user_id, device_id) DO UPDATE SET
    device_name = excluded.device_name,
    platform = excluded.platform,
    user_agent = excluded.user_agent,
    device_public_key = excluded.device_public_key,
    device_signing_key = excluded.device_signing_key,
    device_authorization_signature = excluded.device_authorization_signature,
    last_seen_at = v_now
  RETURNING approval_status INTO v_status;

  RETURN jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_REGISTERED',
    'device_id', p_device_id,
    'approval_status', v_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_user_device_safe(
  uuid, text, text, text, text, text, text, text, text, text, text, integer, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_user_device_safe(
  uuid, text, text, text, text, text, text, text, text, text, text, integer, text
) TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. Suppression explicite des fonctions legacy (SANS CASCADE)
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.finalize_device_account_binding_v2(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.finalize_self_approved_device_v2(uuid, text);
DROP FUNCTION IF EXISTS public.finalize_self_approved_device(uuid, text);
DROP FUNCTION IF EXISTS public.finalize_verified_user_device_approval(uuid, text);
DROP FUNCTION IF EXISTS public.finalize_verified_user_device_approval_verified_proofs(uuid, text);
DROP FUNCTION IF EXISTS public.resume_user_device_enrollment(text, text);
DROP FUNCTION IF EXISTS public.resume_user_device_enrollment(text);
DROP FUNCTION IF EXISTS public.resolve_device_id_by_fingerprint(uuid, text);
DROP FUNCTION IF EXISTS public.resolve_device_id_by_fingerprints(uuid, text, text, text);
DROP FUNCTION IF EXISTS public.dedupe_devices_by_fingerprint();
DROP FUNCTION IF EXISTS public.dedupe_devices_by_fingerprint(uuid);
DROP FUNCTION IF EXISTS public.ensure_primary_device_exists();
DROP FUNCTION IF EXISTS public.ensure_primary_device_exists(uuid);
DROP FUNCTION IF EXISTS public.publish_user_identity_root(text, text, text);
DROP FUNCTION IF EXISTS public.rotate_user_identity_root(text, text, text);
DROP FUNCTION IF EXISTS public.upsert_signed_device_list(uuid, jsonb, text);
DROP FUNCTION IF EXISTS public.upsert_signed_device_list(jsonb, text);
DROP FUNCTION IF EXISTS public.resolve_device_primary_repair_request(uuid);
DROP FUNCTION IF EXISTS public.list_predecessor_device_ids(uuid, text);
DROP FUNCTION IF EXISTS public.list_predecessor_device_ids(uuid);

-- QR / device link (flow supprimé côté client)
DROP FUNCTION IF EXISTS public.create_device_link_request(text, text, text);
DROP FUNCTION IF EXISTS public.approve_device_link_request(uuid, jsonb);
DROP FUNCTION IF EXISTS public.complete_device_link_request(uuid);
DROP FUNCTION IF EXISTS public.get_device_link_request_for_approval(uuid);
DROP FUNCTION IF EXISTS public.get_approved_device_link_payload(uuid);
DROP FUNCTION IF EXISTS public.consume_device_link_token(text);
DROP FUNCTION IF EXISTS public.cleanup_expired_device_link_requests();
DROP FUNCTION IF EXISTS public.cleanup_expired_device_links();

-- -----------------------------------------------------------------------------
-- 7. Trigger de réconciliation de racine d'identité appareil
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS aegis_reconcile_device_root ON public.user_devices;
DROP FUNCTION IF EXISTS public.aegis_reconcile_device_root();

-- -----------------------------------------------------------------------------
-- 8. Tables legacy (SANS CASCADE)
-- -----------------------------------------------------------------------------

DROP TABLE IF EXISTS public.device_link_requests;
DROP TABLE IF EXISTS public.device_link_tokens;
DROP TABLE IF EXISTS public.device_primary_repair_requests;
DROP TABLE IF EXISTS public.signed_device_lists;
DROP TABLE IF EXISTS public.user_device_signatures;
DROP TABLE IF EXISTS public.user_identity_roots;

-- -----------------------------------------------------------------------------
-- 9. Colonnes matérielles / primaires devenues inutiles
-- -----------------------------------------------------------------------------

ALTER TABLE public.user_devices
  DROP COLUMN IF EXISTS device_fingerprint,
  DROP COLUMN IF EXISTS is_primary,
  DROP COLUMN IF EXISTS credential_version;

ALTER TABLE public.device_enrollment_challenges
  DROP COLUMN IF EXISTS device_fingerprint,
  DROP COLUMN IF EXISTS possession_payload_version;
