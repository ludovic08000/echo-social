-- Invariant cryptographique modifié : l'approbation d'un appareil n'exige plus
-- un second appareil de confiance. Le device s'auto-approuve, mais UNIQUEMENT
-- après preuve serveur de possession de sa clé Ed25519 (signature du challenge
-- exact consommé) et sous l'identité authentifiée propriétaire. Aucun statut
-- client n'est accepté : la transition 'approved' reste écrite ici seulement.

create or replace function public.get_device_enrollment_approval_mode(p_device_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_device public.user_devices%rowtype;
  v_trusted_count integer;
begin
  if v_uid is null then return jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); end if;
  if p_device_id is null or p_device_id !~ '^dev_[a-f0-9]{32}$' then
    return jsonb_build_object('ok',false,'code','INVALID_DEVICE_ID');
  end if;
  select * into v_device from public.user_devices d where d.user_id=v_uid and d.device_id=p_device_id;
  if not found then return jsonb_build_object('ok',false,'code','DEVICE_NOT_FOUND'); end if;
  select count(*) into v_trusted_count
  from public.user_devices d
  where d.user_id=v_uid
    and d.device_id<>p_device_id
    and d.approval_status='approved'
    and d.is_active=true
    and d.revoked_at is null;
  return jsonb_build_object(
    'ok',true,
    'code','DEVICE_APPROVAL_MODE',
    'device_id',p_device_id,
    'automatic',true,
    'bootstrap_primary',v_trusted_count=0,
    'approval_mode','automatic',
    'trusted_device_count',v_trusted_count
  );
end;
$function$;

create or replace function public.finalize_device_approval_decision(
  p_user_id uuid,
  p_target_device_id text,
  p_challenge_id uuid,
  p_decision text,
  p_approver_device_id text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_target public.user_devices%rowtype;
  v_live_count integer;
  v_now timestamptz := now();
  v_is_first boolean;
begin
  if p_user_id is null or p_target_device_id !~ '^dev_[a-f0-9]{32}$'
     or p_challenge_id is null or p_decision not in ('approve', 'reject') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_DECISION');
  end if;

  -- Auto-approbation serveur : aucun appareil approbateur tiers n'est accepte.
  if p_approver_device_id is not null and p_approver_device_id <> p_target_device_id then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_EXTERNAL_APPROVER_FORBIDDEN');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select * into v_target from public.user_devices d
  where d.user_id = p_user_id and d.device_id = p_target_device_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND'); end if;
  if v_target.approval_challenge_id is distinct from p_challenge_id
     or v_target.approval_status <> 'pending' or v_target.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_PENDING');
  end if;

  select count(*) into v_live_count from public.user_devices d
  where d.user_id = p_user_id and d.device_id <> p_target_device_id
    and d.approval_status = 'approved' and d.is_active = true
    and d.revoked_at is null and d.lifecycle_status = 'ready';

  v_is_first := v_live_count = 0;

  if p_decision = 'reject' then
    update public.user_devices set approval_status = 'rejected', is_active = false,
      lifecycle_status = 'revoked', rejected_at = v_now, rejected_by = p_user_id,
      rejected_by_device_id = null, revoked_at = v_now,
      revoke_reason = 'user_rejected_pending_device', stale_at = v_now,
      binding_status = 'revoked', routing_status = 'unavailable',
      routing_error = 'DEVICE_REJECTED', updated_at = v_now
    where id = v_target.id;
    return jsonb_build_object('ok', true, 'code', 'DEVICE_REVOKED',
      'device_id', p_target_device_id, 'approver_device_id', null);
  end if;

  update public.user_devices set
    device_role = case when v_is_first then 'primary' else 'secondary' end,
    approval_status = 'approved', lifecycle_status = 'approved', is_active = true,
    approved_at = v_now, approved_by = p_user_id,
    approved_by_device_id = null,
    rejected_by_device_id = null, possession_verified_at = coalesce(possession_verified_at, v_now),
    routing_status = 'repairing', routing_error = 'DEVICE_SYNC_REQUIRED', updated_at = v_now
  where id = v_target.id;

  return jsonb_build_object('ok', true, 'code', 'DEVICE_APPROVED',
    'device_id', p_target_device_id,
    'device_role', case when v_is_first then 'primary' else 'secondary' end,
    'approver_device_id', null);
end;
$function$;

create or replace function public.approve_device_enrollment_decision_pre_account_authorization(
  p_decision text,
  p_bootstrap_primary boolean,
  p_approver_device_id text,
  p_device_id text,
  p_challenge_id uuid,
  p_signature text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'aegis_private', 'pg_catalog', 'pg_temp'
as $function$
declare
  v_uid uuid:=auth.uid(); v_device public.user_devices%rowtype;
  v_challenge public.device_enrollment_challenges%rowtype;
  v_trusted_count integer; v_first boolean;
  v_approval text; v_possession text; v_expiry text; v_result jsonb;
begin
  if v_uid is null then return jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); end if;
  if p_decision not in ('approve','reject')
     or p_approver_device_id !~ '^dev_[a-f0-9]{32}$' or p_device_id !~ '^dev_[a-f0-9]{32}$'
     or p_challenge_id is null or length(btrim(coalesce(p_signature,'')))<80 then
    return jsonb_build_object('ok',false,'code','INVALID_APPROVAL_REQUEST');
  end if;
  -- L'appareil courant est le seul decideur legitime : il signe lui-meme sa
  -- decision avec la cle privee dont il vient de prouver la possession.
  if p_approver_device_id <> p_device_id then
    return jsonb_build_object('ok',false,'code','DEVICE_EXTERNAL_APPROVER_FORBIDDEN');
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
  -- Un appareil deja en attente depuis longtemps doit pouvoir etre repris :
  -- l'integrite repose sur les signatures verifiees ci-dessous, pas sur l'age.
  if v_challenge.cancelled_at is not null or v_challenge.consumed_at is null
     or v_challenge.consumed_at>v_challenge.expires_at then
    return jsonb_build_object('ok',false,'code','DEVICE_ENROLLMENT_EXPIRED');
  end if;
  if v_challenge.device_possession_signature is null then
    return jsonb_build_object('ok',false,'code','DEVICE_POSSESSION_PROOF_REQUIRED');
  end if;

  select count(*) into v_trusted_count
  from public.user_devices d
  where d.user_id=v_uid
    and d.device_id<>p_device_id
    and d.approval_status='approved'
    and d.is_active=true
    and d.revoked_at is null;
  v_first:=v_trusted_count=0;

  v_approval:='{"protocol":"forsure-aegis-device-approval-decision","userId":'||to_json(v_uid::text)::text
    ||',"approverDeviceId":'||to_json(p_approver_device_id)::text||',"deviceId":'||to_json(p_device_id)::text
    ||',"challengeId":'||to_json(p_challenge_id::text)::text||',"devicePublicKey":'||to_json(v_device.device_public_key)::text
    ||',"deviceSigningKey":'||to_json(v_device.device_signing_key)::text||',"decision":'||to_json(p_decision)::text||'}';
  v_expiry:=to_char(v_challenge.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_possession:='{"protocol":"forsure-aegis-device-possession","challengeId":'||to_json(p_challenge_id::text)::text
    ||',"deviceId":'||to_json(p_device_id)::text||',"nonceHash":'||to_json(lower(v_challenge.nonce_hash))::text
    ||',"expiresAt":'||to_json(v_expiry)::text||',"devicePublicKey":'||to_json(v_device.device_public_key)::text
    ||',"deviceSigningKey":'||to_json(v_device.device_signing_key)::text||'}';
  if not aegis_private.verify_ed25519_b64(v_device.device_signing_key,btrim(p_signature),v_approval) then
    return jsonb_build_object('ok',false,'code','DEVICE_APPROVAL_SIGNATURE_INVALID');
  end if;
  if not aegis_private.verify_ed25519_b64(v_device.device_signing_key,v_challenge.device_possession_signature,v_possession) then
    return jsonb_build_object('ok',false,'code','DEVICE_POSSESSION_SIGNATURE_INVALID');
  end if;

  v_result:=public.finalize_device_approval_decision(v_uid,p_device_id,p_challenge_id,p_decision,null);
  if v_result is null or coalesce((v_result->>'ok')::boolean,false) is not true then
    return jsonb_build_object('ok',false,'code',coalesce(v_result->>'code','DEVICE_APPROVAL_REJECTED'));
  end if;
  return jsonb_build_object('ok',true,'code',case when p_decision='approve' then 'DEVICE_APPROVED' else 'DEVICE_REVOKED' end,
    'device_id',p_device_id,'challenge_id',p_challenge_id,'device_role',v_result->>'device_role',
    'binding_status',case when p_decision='approve' then 'pending' else 'revoked' end,
    'bootstrap_primary',v_first,'approval_mode','automatic');
end;
$function$;