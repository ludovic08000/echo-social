-- Server-verified device approval.
--
-- Enrollment completion may stage public material, but it must never make a
-- device routable. Only the Edge Function that verifies both Ed25519 proofs may
-- call the service-role finalizer below.

begin;

create or replace function public.register_user_device_safe(
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
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_existing_device public.user_devices%rowtype;
  v_existing_account public.user_public_keys%rowtype;
  v_now timestamptz := now();
begin
  if v_uid is null or p_user_id is distinct from v_uid then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if v_device_id !~ '^dev_[a-f0-9]{32}$'
     or length(trim(coalesce(p_device_public_key, ''))) < 40
     or length(trim(coalesce(p_device_signing_key, ''))) < 40
     or length(trim(coalesce(p_device_authorization_signature, ''))) < 80
     or length(trim(coalesce(p_account_identity_key, ''))) < 40
     or length(trim(coalesce(p_account_signing_key, ''))) < 40
     or length(trim(coalesce(p_account_fingerprint, ''))) < 32
     or length(trim(coalesce(p_account_binding_signature, ''))) < 80 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_AUTHORIZATION');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  select * into v_existing_account
  from public.user_public_keys account
  where account.user_id = v_uid
    and account.is_active = true
  order by account.created_at desc
  limit 1
  for update;

  if found then
    if v_existing_account.identity_key is distinct from p_account_identity_key
       or v_existing_account.signing_key is distinct from p_account_signing_key
       or v_existing_account.fingerprint is distinct from p_account_fingerprint
       or v_existing_account.identity_binding_signature is distinct from p_account_binding_signature
       or v_existing_account.identity_binding_version is distinct from 1 then
      return jsonb_build_object('ok', false, 'code', 'ACCOUNT_IDENTITY_MISMATCH');
    end if;
    update public.user_public_keys
    set updated_at = v_now
    where id = v_existing_account.id;
  else
    insert into public.user_public_keys (
      user_id, identity_key, signing_key, fingerprint, kem_type,
      identity_binding_version, identity_binding_signature,
      is_active, created_at, updated_at
    ) values (
      v_uid, p_account_identity_key, p_account_signing_key,
      p_account_fingerprint, 'X25519', 1, p_account_binding_signature,
      true, v_now, v_now
    );
  end if;

  select * into v_existing_device
  from public.user_devices device
  where device.user_id = v_uid
    and device.device_id = v_device_id
  for update;

  if found and (
    v_existing_device.revoked_at is not null
    or v_existing_device.approval_status = 'rejected'
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED_OR_REJECTED');
  end if;

  if found and (
    v_existing_device.device_public_key is distinct from p_device_public_key
    or v_existing_device.device_signing_key is distinct from p_device_signing_key
    or v_existing_device.device_authorization_signature is distinct from p_device_authorization_signature
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_IDENTITY_MISMATCH');
  end if;

  if found and v_existing_device.approval_status = 'approved'
     and v_existing_device.is_active = true then
    update public.user_devices
    set device_name = nullif(left(trim(coalesce(p_device_name, '')), 120), ''),
        device_fingerprint = nullif(left(trim(coalesce(p_device_fingerprint, '')), 256), ''),
        platform = lower(trim(coalesce(p_platform, 'web'))),
        user_agent = nullif(left(coalesce(p_user_agent, ''), 500), ''),
        last_seen_at = v_now,
        updated_at = v_now
    where user_id = v_uid and device_id = v_device_id;

    return jsonb_build_object(
      'ok', true,
      'code', 'DEVICE_ALREADY_APPROVED',
      'device_id', v_device_id
    );
  end if;

  if found then
    update public.user_devices
    set device_name = nullif(left(trim(coalesce(p_device_name, '')), 120), ''),
        device_fingerprint = nullif(left(trim(coalesce(p_device_fingerprint, '')), 256), ''),
        platform = lower(trim(coalesce(p_platform, 'web'))),
        user_agent = nullif(left(coalesce(p_user_agent, ''), 500), ''),
        last_seen_at = v_now,
        updated_at = v_now,
        is_active = false,
        approval_status = 'pending',
        approval_requested_at = coalesce(approval_requested_at, v_now),
        approved_at = null,
        approved_by = null,
        stale_at = null,
        routing_status = 'repairing',
        routing_error = 'DEVICE_PROOF_VERIFICATION_PENDING',
        routing_checked_at = v_now
    where user_id = v_uid and device_id = v_device_id;
  else
    insert into public.user_devices (
      user_id, device_id, device_name, device_public_key,
      device_signing_key, device_authorization_signature,
      device_fingerprint, platform, user_agent, is_active, last_seen_at,
      approval_status, approval_requested_at, approved_at, approved_by,
      stale_at, routing_status, routing_error, routing_checked_at
    ) values (
      v_uid, v_device_id, nullif(left(trim(coalesce(p_device_name, '')), 120), ''),
      p_device_public_key, p_device_signing_key, p_device_authorization_signature,
      nullif(left(trim(coalesce(p_device_fingerprint, '')), 256), ''),
      lower(trim(coalesce(p_platform, 'web'))),
      nullif(left(coalesce(p_user_agent, ''), 500), ''),
      false, v_now, 'pending', v_now, null, null,
      null, 'repairing', 'DEVICE_PROOF_VERIFICATION_PENDING', v_now
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_ENROLLMENT_STAGED',
    'device_id', v_device_id
  );
end;
$$;

revoke all on function public.register_user_device_safe(
  uuid,text,text,text,text,text,text,text,text,text,text,text,text
) from public, anon, authenticated;

-- Compatibility shim for older clients. Keeping the signature exposed yields a
-- deterministic fail-closed response instead of a schema-cache or permission
-- error, but it can no longer approve anything.
create or replace function public.approve_user_device(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  return jsonb_build_object(
    'ok', false,
    'code', 'DEVICE_APPROVAL_VERIFICATION_REQUIRED',
    'device_id', trim(coalesce(p_device_id, ''))
  );
end;
$$;

revoke all on function public.approve_user_device(text) from public, anon;
grant execute on function public.approve_user_device(text) to authenticated;

create or replace function public.finalize_verified_user_device_approval(
  p_user_id uuid,
  p_device_id text,
  p_device_public_key text,
  p_device_signing_key text,
  p_device_authorization_signature text,
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
  v_device public.user_devices%rowtype;
  v_account public.user_public_keys%rowtype;
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_now timestamptz := now();
begin
  if p_user_id is null or v_device_id !~ '^dev_[a-f0-9]{32}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_APPROVAL_INPUT');
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
     or v_account.identity_binding_version is distinct from p_account_binding_version
     or p_account_binding_version is distinct from 1 then
    return jsonb_build_object('ok', false, 'code', 'ACCOUNT_PROOF_CHANGED');
  end if;

  select * into v_device
  from public.user_devices device
  where device.user_id = p_user_id
    and device.device_id = v_device_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND');
  end if;
  if v_device.revoked_at is not null or v_device.approval_status = 'rejected' then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED_OR_REJECTED');
  end if;
  if v_device.device_public_key is distinct from p_device_public_key
     or v_device.device_signing_key is distinct from p_device_signing_key
     or v_device.device_authorization_signature is distinct from p_device_authorization_signature then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_PROOF_CHANGED');
  end if;
  if not exists (
    select 1
    from public.device_enrollment_challenges challenge
    where challenge.user_id = p_user_id
      and challenge.device_id = v_device_id
      and challenge.consumed_at is not null
      and challenge.cancelled_at is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_NOT_COMPLETED');
  end if;

  update public.user_devices
  set approval_status = 'approved',
      is_active = true,
      approved_at = coalesce(approved_at, v_now),
      approved_by = coalesce(approved_by, p_user_id),
      rejected_at = null,
      rejected_by = null,
      stale_at = null,
      last_seen_at = v_now,
      updated_at = v_now,
      routing_status = case
        when exists (
          select 1 from public.device_signed_prekeys spk
          where spk.user_id = p_user_id
            and spk.device_id = v_device_id
            and spk.is_active = true
            and spk.expires_at > v_now
        ) then 'ready' else 'repairing' end,
      routing_error = case
        when exists (
          select 1 from public.device_signed_prekeys spk
          where spk.user_id = p_user_id
            and spk.device_id = v_device_id
            and spk.is_active = true
            and spk.expires_at > v_now
        ) then null else 'SIGNED_PREKEY_VALIDATION_PENDING' end,
      routing_checked_at = v_now
  where user_id = p_user_id and device_id = v_device_id;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_APPROVED',
    'device_id', v_device_id,
    'existing', v_device.approval_status = 'approved' and v_device.is_active = true
  );
end;
$$;

revoke all on function public.finalize_verified_user_device_approval(
  uuid,text,text,text,text,text,text,text,text,integer
) from public, anon, authenticated;
grant execute on function public.finalize_verified_user_device_approval(
  uuid,text,text,text,text,text,text,text,text,integer
) to service_role;

notify pgrst, 'reload schema';

commit;
