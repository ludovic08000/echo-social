-- Allow a pending device to be approved either by another trusted device or
-- by proof of possession of the stable account identity. A genuinely new
-- account may bootstrap exactly one first device when no account identity and
-- no other device exist.

begin;

alter table public.user_devices
  add column if not exists approval_method text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_devices_approval_method_check'
      and conrelid = 'public.user_devices'::regclass
  ) then
    alter table public.user_devices
      add constraint user_devices_approval_method_check
      check (
        approval_method is null
        or approval_method in ('trusted_device', 'account_recovery', 'first_device_bootstrap')
      );
  end if;
end;
$$;

-- Stage candidates before account recovery. Existing accounts must match the
-- pinned fingerprint. A missing server identity is accepted only when this is
-- the first and only device candidate for the account.
create or replace function public.complete_user_device_enrollment_candidate(
  p_challenge_id uuid,
  p_nonce text,
  p_device_public_key text,
  p_device_signing_key text,
  p_device_possession_signature text,
  p_account_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_challenge public.device_enrollment_challenges%rowtype;
  v_account public.user_public_keys%rowtype;
  v_device public.user_devices%rowtype;
  v_nonce_hash text;
  v_device_exists boolean := false;
  v_other_device_exists boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if p_challenge_id is null
     or length(coalesce(p_nonce, '')) < 32
     or length(trim(coalesce(p_device_public_key, ''))) < 40
     or length(trim(coalesce(p_device_signing_key, ''))) < 40
     or length(trim(coalesce(p_device_possession_signature, ''))) < 80
     or length(trim(coalesce(p_account_fingerprint, ''))) < 32 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_CANDIDATE');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  select * into v_challenge
  from public.device_enrollment_challenges challenge
  where challenge.id = p_challenge_id
    and challenge.user_id = v_uid
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_CHALLENGE_NOT_FOUND');
  end if;

  v_nonce_hash := encode(
    extensions.digest(convert_to(p_nonce, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_nonce_hash is distinct from v_challenge.nonce_hash then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_INVALID_NONCE');
  end if;
  if v_challenge.cancelled_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_CANCELLED');
  end if;
  if v_challenge.expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_EXPIRED');
  end if;

  select * into v_account
  from public.user_public_keys account
  where account.user_id = v_uid
    and account.is_active = true
  order by account.created_at desc
  limit 1
  for update;

  if found then
    if v_account.fingerprint is distinct from trim(p_account_fingerprint) then
      return jsonb_build_object('ok', false, 'code', 'ACCOUNT_IDENTITY_MISMATCH');
    end if;
  else
    select exists (
      select 1
      from public.user_devices device
      where device.user_id = v_uid
        and device.device_id <> v_challenge.device_id
    ) into v_other_device_exists;

    if v_other_device_exists then
      return jsonb_build_object('ok', false, 'code', 'ACCOUNT_IDENTITY_NOT_FOUND');
    end if;
  end if;

  select * into v_device
  from public.user_devices device
  where device.user_id = v_uid
    and device.device_id = v_challenge.device_id
  for update;
  v_device_exists := found;

  if v_device_exists and (
    v_device.revoked_at is not null
    or v_device.approval_status = 'rejected'
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED_OR_REJECTED');
  end if;
  if v_device_exists and (
    v_device.device_public_key is distinct from trim(p_device_public_key)
    or v_device.device_signing_key is distinct from trim(p_device_signing_key)
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_IDENTITY_MISMATCH');
  end if;

  if v_challenge.consumed_at is not null then
    if v_device_exists
       and v_device.approval_status = 'pending'
       and v_device.revoked_at is null
       and v_challenge.possession_payload_version = 1
       and v_challenge.device_possession_signature is not distinct from trim(p_device_possession_signature) then
      update public.user_devices
      set approval_challenge_id = v_challenge.id,
          updated_at = v_now
      where user_id = v_uid
        and device_id = v_challenge.device_id;

      return jsonb_build_object(
        'ok', true,
        'code', 'DEVICE_ENROLLMENT_ALREADY_COMPLETED',
        'challenge_id', v_challenge.id,
        'device_id', v_challenge.device_id,
        'routing_status', 'repairing'
      );
    end if;
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_REPLAYED');
  end if;

  if v_device_exists then
    update public.user_devices
    set device_name = nullif(left(trim(coalesce(v_challenge.device_name, '')), 120), ''),
        device_public_key = trim(p_device_public_key),
        device_signing_key = trim(p_device_signing_key),
        device_authorization_signature = null,
        device_fingerprint = nullif(left(trim(coalesce(v_challenge.device_fingerprint, '')), 256), ''),
        platform = lower(trim(coalesce(v_challenge.platform, 'web'))),
        user_agent = nullif(left(coalesce(v_challenge.user_agent, ''), 500), ''),
        is_active = false,
        approval_status = 'pending',
        approval_requested_at = coalesce(approval_requested_at, v_now),
        approval_challenge_id = v_challenge.id,
        approval_method = null,
        approved_at = null,
        approved_by = null,
        approved_by_device_id = null,
        rejected_at = null,
        rejected_by = null,
        rejected_by_device_id = null,
        revoked_at = null,
        revoke_reason = null,
        stale_at = null,
        routing_status = 'repairing',
        routing_error = 'DEVICE_APPROVAL_PENDING',
        routing_checked_at = v_now,
        last_seen_at = v_now,
        updated_at = v_now
    where user_id = v_uid
      and device_id = v_challenge.device_id;
  else
    insert into public.user_devices (
      user_id,
      device_id,
      device_name,
      device_public_key,
      device_signing_key,
      device_authorization_signature,
      device_fingerprint,
      platform,
      user_agent,
      is_active,
      last_seen_at,
      approval_status,
      approval_requested_at,
      approval_challenge_id,
      approval_method,
      approved_at,
      approved_by,
      stale_at,
      routing_status,
      routing_error,
      routing_checked_at,
      created_at,
      updated_at
    ) values (
      v_uid,
      v_challenge.device_id,
      nullif(left(trim(coalesce(v_challenge.device_name, '')), 120), ''),
      trim(p_device_public_key),
      trim(p_device_signing_key),
      null,
      nullif(left(trim(coalesce(v_challenge.device_fingerprint, '')), 256), ''),
      lower(trim(coalesce(v_challenge.platform, 'web'))),
      nullif(left(coalesce(v_challenge.user_agent, ''), 500), ''),
      false,
      v_now,
      'pending',
      v_now,
      v_challenge.id,
      null,
      null,
      null,
      null,
      'repairing',
      'DEVICE_APPROVAL_PENDING',
      v_now,
      v_now,
      v_now
    );
  end if;

  update public.device_enrollment_challenges
  set consumed_at = v_now,
      device_possession_signature = trim(p_device_possession_signature),
      possession_payload_version = 1
  where id = v_challenge.id;

  if v_challenge.device_fingerprint is not null then
    update public.device_enrollment_challenges
    set cancelled_at = v_now,
        cancel_reason = 'superseded_by_completed_enrollment'
    where user_id = v_uid
      and id <> v_challenge.id
      and device_fingerprint = v_challenge.device_fingerprint
      and platform = v_challenge.platform
      and consumed_at is null
      and cancelled_at is null;
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_ENROLLMENT_COMPLETED',
    'challenge_id', v_challenge.id,
    'device_id', v_challenge.device_id,
    'routing_status', 'repairing',
    'first_device_candidate', not found
  );
end;
$$;

revoke all on function public.complete_user_device_enrollment_candidate(
  uuid,text,text,text,text,text
) from public, anon;
grant execute on function public.complete_user_device_enrollment_candidate(
  uuid,text,text,text,text,text
) to authenticated;

create or replace function public.finalize_verified_user_device_approval_from_recovery(
  p_user_id uuid,
  p_challenge_id uuid,
  p_device_id text,
  p_device_public_key text,
  p_device_signing_key text,
  p_device_authorization_signature text,
  p_device_possession_signature text,
  p_account_identity_key text,
  p_account_signing_key text,
  p_account_fingerprint text,
  p_account_binding_signature text,
  p_account_binding_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account public.user_public_keys%rowtype;
  v_target public.user_devices%rowtype;
  v_result jsonb;
  v_previous_authorization text;
  v_device_id text := trim(coalesce(p_device_id, ''));
begin
  if p_user_id is null
     or p_challenge_id is null
     or v_device_id !~ '^dev_[a-f0-9]{32}$'
     or length(trim(coalesce(p_device_authorization_signature, ''))) < 80 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_RECOVERY_INPUT');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select * into v_account
  from public.user_public_keys account
  where account.user_id = p_user_id
    and account.is_active = true
  order by account.created_at desc
  limit 1
  for update;

  if not found
     or v_account.identity_key is distinct from p_account_identity_key
     or v_account.signing_key is distinct from p_account_signing_key
     or v_account.fingerprint is distinct from p_account_fingerprint
     or v_account.identity_binding_signature is distinct from p_account_binding_signature
     or v_account.identity_binding_version is distinct from p_account_binding_version then
    return jsonb_build_object('ok', false, 'code', 'ACCOUNT_RECOVERY_IDENTITY_MISMATCH');
  end if;

  select * into v_target
  from public.user_devices device
  where device.user_id = p_user_id
    and device.device_id = v_device_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND');
  end if;
  if v_target.approval_status is distinct from 'pending'
     or v_target.is_active is distinct from false
     or v_target.revoked_at is not null
     or v_target.approval_challenge_id is distinct from p_challenge_id
     or v_target.device_public_key is distinct from p_device_public_key
     or v_target.device_signing_key is distinct from p_device_signing_key then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_RECOVERY_TARGET_CHANGED');
  end if;

  v_previous_authorization := v_target.device_authorization_signature;
  update public.user_devices
  set device_authorization_signature = trim(p_device_authorization_signature),
      updated_at = now()
  where user_id = p_user_id
    and device_id = v_device_id;

  v_result := public.finalize_verified_user_device_approval(
    p_user_id,
    p_challenge_id,
    v_device_id,
    p_device_public_key,
    p_device_signing_key,
    p_device_authorization_signature,
    p_device_possession_signature,
    p_account_identity_key,
    p_account_signing_key,
    p_account_fingerprint,
    p_account_binding_signature,
    p_account_binding_version
  );

  if coalesce((v_result ->> 'ok')::boolean, false) is not true
     or v_result ->> 'code' <> 'DEVICE_APPROVED' then
    update public.user_devices
    set device_authorization_signature = v_previous_authorization,
        updated_at = now()
    where user_id = p_user_id
      and device_id = v_device_id;
    return v_result;
  end if;

  update public.user_devices
  set approval_method = 'account_recovery',
      approved_by_device_id = null,
      updated_at = now()
  where user_id = p_user_id
    and device_id = v_device_id;

  return v_result || jsonb_build_object('mode', 'account_recovery');
end;
$$;

revoke all on function public.finalize_verified_user_device_approval_from_recovery(
  uuid,uuid,text,text,text,text,text,text,text,text,text,integer
) from public, anon, authenticated;
grant execute on function public.finalize_verified_user_device_approval_from_recovery(
  uuid,uuid,text,text,text,text,text,text,text,text,text,integer
) to service_role;

create or replace function public.finalize_verified_first_user_device(
  p_user_id uuid,
  p_challenge_id uuid,
  p_device_id text,
  p_device_public_key text,
  p_device_signing_key text,
  p_device_authorization_signature text,
  p_device_possession_signature text,
  p_account_identity_key text,
  p_account_signing_key text,
  p_account_fingerprint text,
  p_account_binding_signature text,
  p_account_binding_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target public.user_devices%rowtype;
  v_result jsonb;
  v_account_id uuid;
  v_previous_authorization text;
  v_device_id text := trim(coalesce(p_device_id, ''));
begin
  if p_user_id is null
     or p_challenge_id is null
     or v_device_id !~ '^dev_[a-f0-9]{32}$'
     or p_account_binding_version is distinct from 1
     or length(trim(coalesce(p_account_identity_key, ''))) < 40
     or length(trim(coalesce(p_account_signing_key, ''))) < 40
     or length(trim(coalesce(p_account_fingerprint, ''))) < 32
     or length(trim(coalesce(p_account_binding_signature, ''))) < 80
     or length(trim(coalesce(p_device_authorization_signature, ''))) < 80 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_FIRST_DEVICE_INPUT');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  if exists (
    select 1
    from public.user_public_keys account
    where account.user_id = p_user_id
      and account.is_active = true
  ) then
    return jsonb_build_object('ok', false, 'code', 'FIRST_DEVICE_ACCOUNT_ALREADY_INITIALIZED');
  end if;

  if exists (
    select 1
    from public.user_devices device
    where device.user_id = p_user_id
      and device.device_id <> v_device_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'FIRST_DEVICE_BOOTSTRAP_FORBIDDEN');
  end if;

  select * into v_target
  from public.user_devices device
  where device.user_id = p_user_id
    and device.device_id = v_device_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND');
  end if;
  if v_target.approval_status is distinct from 'pending'
     or v_target.is_active is distinct from false
     or v_target.revoked_at is not null
     or v_target.approval_challenge_id is distinct from p_challenge_id
     or v_target.device_public_key is distinct from p_device_public_key
     or v_target.device_signing_key is distinct from p_device_signing_key then
    return jsonb_build_object('ok', false, 'code', 'FIRST_DEVICE_TARGET_CHANGED');
  end if;

  insert into public.user_public_keys (
    user_id,
    identity_key,
    signing_key,
    fingerprint,
    kem_type,
    identity_binding_version,
    identity_binding_signature,
    is_active,
    created_at,
    updated_at
  ) values (
    p_user_id,
    trim(p_account_identity_key),
    trim(p_account_signing_key),
    trim(p_account_fingerprint),
    'X25519',
    p_account_binding_version,
    trim(p_account_binding_signature),
    true,
    now(),
    now()
  ) returning id into v_account_id;

  v_previous_authorization := v_target.device_authorization_signature;
  update public.user_devices
  set device_authorization_signature = trim(p_device_authorization_signature),
      updated_at = now()
  where user_id = p_user_id
    and device_id = v_device_id;

  v_result := public.finalize_verified_user_device_approval(
    p_user_id,
    p_challenge_id,
    v_device_id,
    p_device_public_key,
    p_device_signing_key,
    p_device_authorization_signature,
    p_device_possession_signature,
    p_account_identity_key,
    p_account_signing_key,
    p_account_fingerprint,
    p_account_binding_signature,
    p_account_binding_version
  );

  if coalesce((v_result ->> 'ok')::boolean, false) is not true
     or v_result ->> 'code' <> 'DEVICE_APPROVED' then
    delete from public.user_public_keys where id = v_account_id;
    update public.user_devices
    set device_authorization_signature = v_previous_authorization,
        updated_at = now()
    where user_id = p_user_id
      and device_id = v_device_id;
    return v_result;
  end if;

  update public.user_devices
  set approval_method = 'first_device_bootstrap',
      approved_by_device_id = null,
      updated_at = now()
  where user_id = p_user_id
    and device_id = v_device_id;

  return v_result || jsonb_build_object('mode', 'first_device_bootstrap');
end;
$$;

revoke all on function public.finalize_verified_first_user_device(
  uuid,uuid,text,text,text,text,text,text,text,text,text,integer
) from public, anon, authenticated;
grant execute on function public.finalize_verified_first_user_device(
  uuid,uuid,text,text,text,text,text,text,text,text,text,integer
) to service_role;

notify pgrst, 'reload schema';

commit;
