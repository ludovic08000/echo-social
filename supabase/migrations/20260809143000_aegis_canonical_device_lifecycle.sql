-- Canonical device lifecycle: one enrollment flow, no browser fingerprint trust,
-- no primary-device/signed-device-list graph, no QR device-link tables.
-- Validated against Lovable Cloud PostgreSQL with BEGIN/ROLLBACK before commit.

DROP TRIGGER IF EXISTS trg_dedupe_devices_by_fingerprint ON public.user_devices;
DROP TRIGGER IF EXISTS trg_guard_user_device_lifecycle ON public.user_devices;
DROP TRIGGER IF EXISTS aegis_reconcile_device_root ON public.user_devices;
DROP INDEX IF EXISTS public.user_devices_one_primary_per_user;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname IN ('begin_user_device_enrollment','complete_user_device_enrollment','revoke_user_device','list_active_devices_for_user')
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', r.signature);
  END LOOP;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND (
        p.proname IN (
          'approve_device_link_request','approve_user_device','cleanup_expired_device_link_requests','cleanup_expired_device_links',
          'complete_device_link_request','consume_device_link_token','create_device_link_request','dedupe_devices_by_fingerprint',
          'ensure_primary_device_exists','finalize_verified_user_device_approval','finalize_verified_user_device_approval_verified_proofs',
          'get_approved_device_link_payload','get_device_link_request_for_approval','get_sesame_device_list','list_predecessor_device_ids',
          'notify_new_device','publish_user_identity_root','register_user_device_safe','resolve_device_id_by_fingerprint',
          'resolve_device_primary_repair_request','resume_user_device_enrollment','rotate_user_identity_root','upsert_signed_device_list',
          'verify_own_key_consistency','trg_aegis_reconcile_device_root'
        )
        OR p.proname IN ('complete_user_device_enrollment_v2','finalize_device_account_binding_v2','finalize_self_approved_device_v2')
      )
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', r.signature);
  END LOOP;
END $$;

DROP TABLE IF EXISTS public.device_link_requests;
DROP TABLE IF EXISTS public.device_link_tokens;
DROP TABLE IF EXISTS public.device_primary_repair_requests;
DROP TABLE IF EXISTS public.signed_device_lists;
DROP TABLE IF EXISTS public.user_device_signatures;
DROP TABLE IF EXISTS public.user_identity_roots;

ALTER TABLE public.device_enrollment_challenges DROP COLUMN IF EXISTS device_fingerprint;
ALTER TABLE public.user_devices
  DROP COLUMN IF EXISTS device_fingerprint,
  DROP COLUMN IF EXISTS is_primary,
  DROP COLUMN IF EXISTS credential_version;

CREATE OR REPLACE FUNCTION public.guard_user_device_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.is_active=TRUE THEN
    RAISE EXCEPTION 'USER_DEVICES_REACTIVATION_BLOCKED'
      USING ERRCODE='23514', DETAIL=format('Revoked DeviceID %s cannot be reactivated.',OLD.device_id);
  END IF;

  IF OLD.revoked_at IS NULL
     AND (NEW.revoked_at IS NOT NULL OR (OLD.is_active=TRUE AND NEW.is_active=FALSE))
     AND NOT (
       coalesce(NEW.revoke_reason,'')='manual'
       OR (
         OLD.approval_status='pending'
         AND NEW.approval_status='rejected'
         AND coalesce(NEW.revoke_reason,'')='user_rejected_pending_device'
       )
     ) THEN
    RAISE EXCEPTION 'DEVICE_REVOCATION_REQUIRES_EXPLICIT_USER_ACTION'
      USING ERRCODE='23514', DETAIL=format('DeviceID %s may only be explicitly revoked or rejected.',OLD.device_id);
  END IF;

  IF NEW.revoked_at IS NOT NULL THEN
    NEW.is_active:=FALSE;
    NEW.binding_status:='revoked';
    NEW.routing_status:='unavailable';
    NEW.routing_error:=coalesce(NEW.routing_error,'DEVICE_REVOKED');
    NEW.stale_at:=coalesce(NEW.stale_at,NEW.revoked_at);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_guard_user_device_lifecycle
BEFORE UPDATE ON public.user_devices
FOR EACH ROW EXECUTE FUNCTION public.guard_user_device_lifecycle();

CREATE OR REPLACE FUNCTION public.begin_user_device_enrollment(
  p_device_name text DEFAULT NULL,
  p_platform text DEFAULT 'web',
  p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_uid uuid:=auth.uid();
  v_now timestamptz:=now();
  v_platform text:=lower(trim(coalesce(p_platform,'web')));
  v_device_id text;
  v_nonce text;
  v_nonce_hash text;
  v_challenge_id uuid;
  v_expires_at timestamptz:=v_now+interval '10 minutes';
  v_active_count integer;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); END IF;
  IF v_platform NOT IN ('ios','android','web') THEN RETURN jsonb_build_object('ok',false,'code','INVALID_PLATFORM'); END IF;

  DELETE FROM public.device_enrollment_challenges
  WHERE user_id=v_uid
    AND (expires_at<v_now-interval '1 hour' OR consumed_at<v_now-interval '1 hour' OR cancelled_at<v_now-interval '1 hour');

  SELECT count(*) INTO v_active_count
  FROM public.device_enrollment_challenges
  WHERE user_id=v_uid AND consumed_at IS NULL AND cancelled_at IS NULL AND expires_at>v_now;
  IF v_active_count>=5 THEN RETURN jsonb_build_object('ok',false,'code','DEVICE_ENROLLMENT_RATE_LIMITED'); END IF;

  v_device_id:='dev_'||replace(gen_random_uuid()::text,'-','');
  v_nonce:=encode(extensions.gen_random_bytes(32),'base64');
  v_nonce_hash:=encode(extensions.digest(convert_to(v_nonce,'UTF8'),'sha256'),'hex');

  INSERT INTO public.device_enrollment_challenges(user_id,device_id,nonce_hash,device_name,platform,user_agent,created_at,expires_at)
  VALUES(v_uid,v_device_id,v_nonce_hash,nullif(left(trim(coalesce(p_device_name,'')),120),''),v_platform,
         nullif(left(coalesce(p_user_agent,''),500),''),v_now,v_expires_at)
  RETURNING id INTO v_challenge_id;

  RETURN jsonb_build_object('ok',true,'code','DEVICE_ENROLLMENT_CHALLENGE_CREATED','challenge_id',v_challenge_id,
                            'device_id',v_device_id,'nonce',v_nonce,'expires_at',v_expires_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_user_device_enrollment(
  p_challenge_id uuid,
  p_nonce text,
  p_device_public_key text,
  p_device_signing_key text,
  p_device_possession_signature text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_uid uuid:=auth.uid();
  v_now timestamptz:=now();
  v_challenge public.device_enrollment_challenges%rowtype;
  v_nonce_hash text;
  v_existing public.user_devices%rowtype;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); END IF;
  IF p_challenge_id IS NULL OR length(coalesce(p_nonce,''))<32
     OR length(trim(coalesce(p_device_public_key,'')))<40
     OR length(trim(coalesce(p_device_signing_key,'')))<40
     OR length(trim(coalesce(p_device_possession_signature,'')))<80 THEN
    RETURN jsonb_build_object('ok',false,'code','INVALID_DEVICE_ENROLLMENT_INPUT');
  END IF;

  SELECT * INTO v_challenge FROM public.device_enrollment_challenges c
  WHERE c.id=p_challenge_id AND c.user_id=v_uid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','DEVICE_ENROLLMENT_CHALLENGE_NOT_FOUND'); END IF;
  IF v_challenge.cancelled_at IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'code','DEVICE_ENROLLMENT_CANCELLED'); END IF;
  IF v_challenge.expires_at<=v_now THEN RETURN jsonb_build_object('ok',false,'code','DEVICE_ENROLLMENT_EXPIRED'); END IF;

  v_nonce_hash:=encode(extensions.digest(convert_to(p_nonce,'UTF8'),'sha256'),'hex');
  IF v_nonce_hash IS DISTINCT FROM v_challenge.nonce_hash THEN
    RETURN jsonb_build_object('ok',false,'code','DEVICE_ENROLLMENT_INVALID_NONCE');
  END IF;

  SELECT * INTO v_existing FROM public.user_devices d
  WHERE d.user_id=v_uid AND d.device_id=v_challenge.device_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.revoked_at IS NOT NULL OR v_existing.approval_status='rejected' THEN
      RETURN jsonb_build_object('ok',false,'code','DEVICE_REVOKED_OR_REJECTED');
    END IF;
    IF v_existing.device_public_key IS DISTINCT FROM trim(p_device_public_key)
       OR v_existing.device_signing_key IS DISTINCT FROM trim(p_device_signing_key) THEN
      RETURN jsonb_build_object('ok',false,'code','DEVICE_IDENTITY_MISMATCH');
    END IF;
  ELSE
    INSERT INTO public.user_devices(
      user_id,device_id,device_name,device_public_key,device_signing_key,device_authorization_signature,
      platform,user_agent,is_active,last_seen_at,approval_status,approval_requested_at,routing_status,routing_error,
      routing_checked_at,approval_challenge_id,binding_status,account_bound_at,possession_verified_at
    ) VALUES(
      v_uid,v_challenge.device_id,v_challenge.device_name,trim(p_device_public_key),trim(p_device_signing_key),NULL,
      v_challenge.platform,v_challenge.user_agent,FALSE,v_now,'pending',v_now,'repairing','DEVICE_APPROVAL_PENDING',
      v_now,v_challenge.id,'pending',NULL,NULL
    );
  END IF;

  UPDATE public.device_enrollment_challenges
  SET consumed_at=coalesce(consumed_at,v_now),device_possession_signature=trim(p_device_possession_signature)
  WHERE id=v_challenge.id;

  UPDATE public.user_devices
  SET approval_challenge_id=v_challenge.id,approval_status='pending',is_active=FALSE,binding_status='pending',
      account_bound_at=NULL,device_authorization_signature=NULL,routing_status='repairing',
      routing_error='DEVICE_APPROVAL_PENDING',routing_checked_at=v_now,updated_at=v_now
  WHERE user_id=v_uid AND device_id=v_challenge.device_id;

  RETURN jsonb_build_object('ok',true,'code','DEVICE_ENROLLMENT_STAGED','challenge_id',v_challenge.id,
                            'device_id',v_challenge.device_id,'approval_status','pending','binding_status','pending');
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_active_devices_for_user(p_user_id uuid)
RETURNS TABLE(device_id text,device_public_key text,platform text,last_seen_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
  SELECT ud.device_id,ud.device_public_key,ud.platform,ud.last_seen_at
  FROM public.user_devices ud
  WHERE ud.user_id=p_user_id
    AND ud.is_active=TRUE
    AND ud.approval_status='approved'
    AND ud.binding_status='bound'
    AND ud.routing_status='ready'
    AND ud.revoked_at IS NULL
    AND ud.stale_at IS NULL
    AND nullif(trim(coalesce(ud.device_public_key,'')),'') IS NOT NULL
    AND EXISTS(
      SELECT 1 FROM public.device_signed_prekeys dsp
      WHERE dsp.user_id=ud.user_id AND dsp.device_id=ud.device_id AND dsp.is_active=TRUE
        AND nullif(trim(coalesce(dsp.public_key,'')),'') IS NOT NULL
        AND nullif(trim(coalesce(dsp.signature,'')),'') IS NOT NULL
        AND (dsp.expires_at IS NULL OR dsp.expires_at>now())
    )
    AND NOT EXISTS(
      SELECT 1 FROM public.invalid_e2ee_devices bad
      WHERE bad.user_id=ud.user_id AND bad.device_id=ud.device_id
    )
  ORDER BY ud.last_seen_at DESC NULLS LAST;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_user_device(p_device_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_uid uuid:=auth.uid();
  v_device_id text:=trim(coalesce(p_device_id,''));
  v_target public.user_devices%rowtype;
  v_now timestamptz:=now();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated' USING ERRCODE='42501'; END IF;
  IF v_device_id !~ '^dev_[a-f0-9]{32}$' THEN RAISE EXCEPTION 'INVALID_DEVICE_ID' USING ERRCODE='22023'; END IF;

  SELECT * INTO v_target FROM public.user_devices
  WHERE user_id=v_uid AND device_id=v_device_id AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEVICE_NOT_FOUND_OR_ALREADY_REVOKED' USING ERRCODE='P0002'; END IF;

  UPDATE public.user_devices
  SET is_active=FALSE,revoked_at=v_now,revoke_reason='manual',stale_at=coalesce(stale_at,v_now),
      binding_status='revoked',routing_status='unavailable',routing_error='DEVICE_REVOKED',
      routing_checked_at=v_now,updated_at=v_now
  WHERE id=v_target.id;

  UPDATE public.device_signed_prekeys SET is_active=FALSE,updated_at=v_now
  WHERE user_id=v_uid AND device_id=v_device_id AND is_active=TRUE;

  DELETE FROM public.device_one_time_prekeys WHERE user_id=v_uid AND device_id=v_device_id;

  RETURN jsonb_build_object('ok',true,'device_id',v_device_id,'status','revoked');
END;
$function$;

REVOKE ALL ON FUNCTION public.begin_user_device_enrollment(text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.complete_user_device_enrollment(uuid,text,text,text,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.list_active_devices_for_user(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.revoke_user_device(text) FROM PUBLIC,anon;

GRANT EXECUTE ON FUNCTION public.begin_user_device_enrollment(text,text,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.complete_user_device_enrollment(uuid,text,text,text,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.list_active_devices_for_user(uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.revoke_user_device(text) TO authenticated,service_role;
