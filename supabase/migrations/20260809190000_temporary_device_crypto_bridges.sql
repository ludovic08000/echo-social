-- Ponts RPC temporaires Lovable Cloud. Les cles privees restent exclusivement
-- locales : PostgreSQL ne recoit que des cles publiques et des signatures.

create schema if not exists aegis_private;
revoke all on schema aegis_private from public, anon, authenticated;

create or replace function aegis_private.verify_ed25519_b64(
  p_public_key_b64 text,
  p_signature_b64 text,
  p_payload text
) returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pgsodium, pg_temp
as $function$
declare
  v_key_text text;
  v_sig_text text;
  v_key bytea;
  v_sig bytea;
begin
  if p_public_key_b64 is null or p_signature_b64 is null or p_payload is null then return false; end if;
  v_key_text := translate(btrim(p_public_key_b64), '-_', '+/');
  v_sig_text := translate(btrim(p_signature_b64), '-_', '+/');
  if v_key_text = '' or v_sig_text = ''
     or v_key_text !~ '^[A-Za-z0-9+/]*={0,2}$'
     or v_sig_text !~ '^[A-Za-z0-9+/]*={0,2}$' then return false; end if;
  v_key_text := v_key_text || repeat('=', (4 - length(v_key_text) % 4) % 4);
  v_sig_text := v_sig_text || repeat('=', (4 - length(v_sig_text) % 4) % 4);
  begin
    v_key := decode(v_key_text, 'base64');
    v_sig := decode(v_sig_text, 'base64');
  exception when others then return false;
  end;
  if octet_length(v_key) <> 32 or octet_length(v_sig) <> 64 then return false; end if;
  begin
    return pgsodium.crypto_sign_verify_detached(v_sig, convert_to(p_payload, 'UTF8'), v_key);
  exception when others then return false;
  end;
end;
$function$;

revoke all on function aegis_private.verify_ed25519_b64(text,text,text) from public, anon, authenticated;
grant execute on function aegis_private.verify_ed25519_b64(text,text,text) to service_role;

create or replace function public.approve_device_enrollment_decision(
  p_decision text, p_bootstrap_primary boolean, p_approver_device_id text,
  p_device_id text, p_challenge_id uuid, p_signature text
) returns jsonb
language plpgsql security definer
set search_path = public, aegis_private, pg_catalog, pg_temp
as $function$
declare
  v_uid uuid:=auth.uid(); v_device public.user_devices%rowtype;
  v_challenge public.device_enrollment_challenges%rowtype; v_approver public.user_devices%rowtype;
  v_other_count integer; v_first boolean; v_signing_key text; v_finalizer_approver text;
  v_approval text; v_possession text; v_expiry text; v_result jsonb;
begin
  if v_uid is null then return jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); end if;
  if p_decision not in ('approve','reject') or p_bootstrap_primary is null
     or p_approver_device_id !~ '^dev_[a-f0-9]{32}$' or p_device_id !~ '^dev_[a-f0-9]{32}$'
     or p_challenge_id is null or length(btrim(coalesce(p_signature,'')))<80 then
    return jsonb_build_object('ok',false,'code','INVALID_APPROVAL_REQUEST');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text,0));
  select * into v_device from public.user_devices d where d.user_id=v_uid and d.device_id=p_device_id for update;
  if not found then return jsonb_build_object('ok',false,'code','DEVICE_NOT_FOUND'); end if;
  if v_device.approval_status<>'pending' or v_device.is_active<>false or v_device.revoked_at is not null then
    return jsonb_build_object('ok',false,'code','DEVICE_NOT_PENDING');
  end if;
  if v_device.device_public_key is null or v_device.device_signing_key is null
     or v_device.approval_challenge_id is distinct from p_challenge_id then
    return jsonb_build_object('ok',false,'code','DEVICE_PENDING_PROOF_INCOMPLETE');
  end if;
  select * into v_challenge from public.device_enrollment_challenges c
  where c.id=p_challenge_id and c.user_id=v_uid and c.device_id=p_device_id for update;
  if not found then return jsonb_build_object('ok',false,'code','DEVICE_APPROVAL_CHALLENGE_NOT_FOUND'); end if;
  if v_challenge.cancelled_at is not null or v_challenge.consumed_at is null
     or v_challenge.consumed_at>v_challenge.expires_at or v_challenge.expires_at<=now()
     or v_challenge.consumed_at+interval '24 hours'<=now() then
    return jsonb_build_object('ok',false,'code','DEVICE_ENROLLMENT_EXPIRED');
  end if;
  if v_challenge.device_possession_signature is null then
    return jsonb_build_object('ok',false,'code','DEVICE_POSSESSION_PROOF_REQUIRED');
  end if;
  select count(*) into v_other_count from public.user_devices d where d.user_id=v_uid and d.device_id<>p_device_id;
  v_first:=v_other_count=0;
  if p_bootstrap_primary is distinct from v_first then
    return jsonb_build_object('ok',false,'code','DEVICE_BOOTSTRAP_STATE_MISMATCH');
  end if;
  if v_first then
    if p_decision<>'approve' or p_approver_device_id<>p_device_id then
      return jsonb_build_object('ok',false,'code','PRIMARY_BOOTSTRAP_INVALID');
    end if;
    v_signing_key:=v_device.device_signing_key; v_finalizer_approver:=null;
  else
    if p_approver_device_id=p_device_id then return jsonb_build_object('ok',false,'code','DEVICE_SELF_APPROVAL_FORBIDDEN'); end if;
    select * into v_approver from public.user_devices d
    where d.user_id=v_uid and d.device_id=p_approver_device_id for update;
    if not found or v_approver.approval_status<>'approved' or v_approver.is_active<>true
       or v_approver.revoked_at is not null or v_approver.lifecycle_status<>'ready'
       or v_approver.device_signing_key is null then
      return jsonb_build_object('ok',false,'code','APPROVER_DEVICE_NOT_READY');
    end if;
    v_signing_key:=v_approver.device_signing_key; v_finalizer_approver:=p_approver_device_id;
  end if;
  v_approval:='{"protocol":"forsure-aegis-device-approval-decision","userId":'||to_json(v_uid::text)::text
    ||',"approverDeviceId":'||to_json(p_approver_device_id)::text||',"deviceId":'||to_json(p_device_id)::text
    ||',"challengeId":'||to_json(p_challenge_id::text)::text||',"devicePublicKey":'||to_json(v_device.device_public_key)::text
    ||',"deviceSigningKey":'||to_json(v_device.device_signing_key)::text||',"decision":'||to_json(p_decision)::text||'}';
  v_expiry:=to_char(v_challenge.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_possession:='{"protocol":"forsure-aegis-device-possession","challengeId":'||to_json(p_challenge_id::text)::text
    ||',"deviceId":'||to_json(p_device_id)::text||',"nonceHash":'||to_json(lower(v_challenge.nonce_hash))::text
    ||',"expiresAt":'||to_json(v_expiry)::text||',"devicePublicKey":'||to_json(v_device.device_public_key)::text
    ||',"deviceSigningKey":'||to_json(v_device.device_signing_key)::text||'}';
  if not aegis_private.verify_ed25519_b64(v_signing_key,btrim(p_signature),v_approval) then
    return jsonb_build_object('ok',false,'code','DEVICE_APPROVAL_SIGNATURE_INVALID');
  end if;
  if not aegis_private.verify_ed25519_b64(v_device.device_signing_key,v_challenge.device_possession_signature,v_possession) then
    return jsonb_build_object('ok',false,'code','DEVICE_POSSESSION_SIGNATURE_INVALID');
  end if;
  v_result:=public.finalize_device_approval_decision(v_uid,p_device_id,p_challenge_id,p_decision,v_finalizer_approver);
  if v_result is null or coalesce((v_result->>'ok')::boolean,false) is not true then
    return jsonb_build_object('ok',false,'code',coalesce(v_result->>'code','DEVICE_APPROVAL_REJECTED'));
  end if;
  return jsonb_build_object('ok',true,'code',case when p_decision='approve' then 'DEVICE_APPROVED' else 'DEVICE_REVOKED' end,
    'device_id',p_device_id,'challenge_id',p_challenge_id,'device_role',v_result->>'device_role','binding_status','pending');
end;
$function$;

create or replace function public.bind_device_account(
  p_device_id text,
  p_device_authorization_signature text
) returns jsonb
language plpgsql
security definer
set search_path = public, aegis_private, pg_catalog, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_device public.user_devices%rowtype;
  v_account public.user_public_keys%rowtype;
  v_binding_payload text;
  v_authorization_payload text;
  v_digest text;
  v_fingerprint text;
  v_result jsonb;
begin
  if v_uid is null then return jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); end if;
  if p_device_id is null or p_device_id !~ '^dev_[a-f0-9]{32}$'
     or p_device_authorization_signature is null
     or length(btrim(p_device_authorization_signature)) < 80 then
    return jsonb_build_object('ok',false,'code','INVALID_DEVICE_BINDING_INPUT');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  select * into v_device from public.user_devices d
  where d.user_id=v_uid and d.device_id=p_device_id for update;
  if not found then return jsonb_build_object('ok',false,'code','DEVICE_NOT_FOUND'); end if;
  if v_device.approval_status <> 'approved' or v_device.is_active <> true
     or v_device.revoked_at is not null then
    return jsonb_build_object('ok',false,'code','DEVICE_NOT_APPROVED');
  end if;
  if v_device.possession_verified_at is null then
    return jsonb_build_object('ok',false,'code','DEVICE_POSSESSION_NOT_VERIFIED');
  end if;
  if v_device.device_public_key is null or v_device.device_signing_key is null then
    return jsonb_build_object('ok',false,'code','DEVICE_KEYS_INCOMPLETE');
  end if;
  if v_device.binding_status='bound' and v_device.device_authorization_signature is not null then
    if v_device.device_authorization_signature is distinct from btrim(p_device_authorization_signature) then
      return jsonb_build_object('ok',false,'code','DEVICE_AUTHORIZATION_CHANGED');
    end if;
    return jsonb_build_object('ok',true,'code','DEVICE_ACCOUNT_BOUND','device_id',p_device_id,'existing',true);
  end if;
  select * into v_account from public.user_public_keys k
  where k.user_id=v_uid and k.is_active=true order by k.created_at desc limit 1;
  if not found then return jsonb_build_object('ok',false,'code','ACCOUNT_IDENTITY_NOT_FOUND'); end if;
  if v_account.identity_binding_version <> 1 or v_account.identity_binding_signature is null then
    return jsonb_build_object('ok',false,'code','ACCOUNT_BINDING_INCOMPLETE');
  end if;
  v_binding_payload := '{"protocol":"forsure-aegis-account-identity","version":1,"identityKey":'
    || to_json(v_account.identity_key)::text || ',"signingKey":' || to_json(v_account.signing_key)::text || '}';
  v_digest := substring(encode(extensions.digest(convert_to(v_binding_payload,'UTF8'),'sha256'),'hex') from 1 for 40);
  v_fingerprint := upper(substring(v_digest from 1 for 8)||' '||substring(v_digest from 9 for 8)||' '
    ||substring(v_digest from 17 for 8)||' '||substring(v_digest from 25 for 8)||' '||substring(v_digest from 33 for 8));
  if v_fingerprint is distinct from v_account.fingerprint then
    return jsonb_build_object('ok',false,'code','ACCOUNT_FINGERPRINT_INVALID');
  end if;
  if not aegis_private.verify_ed25519_b64(v_account.signing_key,v_account.identity_binding_signature,v_binding_payload) then
    return jsonb_build_object('ok',false,'code','ACCOUNT_BINDING_SIGNATURE_INVALID');
  end if;
  v_authorization_payload := '{"protocol":"forsure-aegis-device-authorization","userId":'
    ||to_json(v_uid::text)::text||',"deviceId":'||to_json(v_device.device_id)::text
    ||',"accountFingerprint":'||to_json(v_account.fingerprint)::text
    ||',"devicePublicKey":'||to_json(v_device.device_public_key)::text
    ||',"deviceSigningKey":'||to_json(v_device.device_signing_key)::text||'}';
  if not aegis_private.verify_ed25519_b64(v_account.signing_key,btrim(p_device_authorization_signature),v_authorization_payload) then
    return jsonb_build_object('ok',false,'code','DEVICE_AUTHORIZATION_SIGNATURE_INVALID');
  end if;
  v_result := public.finalize_device_account_binding(v_uid,p_device_id,btrim(p_device_authorization_signature));
  if v_result is null or coalesce((v_result->>'ok')::boolean,false) is not true then
    return jsonb_build_object('ok',false,'code',coalesce(v_result->>'code','DEVICE_BINDING_REJECTED'));
  end if;
  return jsonb_build_object('ok',true,'code','DEVICE_ACCOUNT_BOUND','device_id',p_device_id,'existing',false);
end;
$function$;

revoke all on function public.bind_device_account(text,text) from public, anon;
grant execute on function public.bind_device_account(text,text) to authenticated, service_role;

revoke all on function public.approve_device_enrollment_decision(text,boolean,text,text,uuid,text) from public, anon;
grant execute on function public.approve_device_enrollment_decision(text,boolean,text,text,uuid,text) to authenticated, service_role;
