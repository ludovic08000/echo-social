-- Aegis account-identity hardening.
--
-- Security invariants:
--   * browser roles cannot mutate the account identity table directly;
--   * the initial public identity is accepted only through a verified binding;
--   * an existing account root can never be silently replaced;
--   * an unrecoverable root reset is service-role-only and is reached through
--     the password-verifying identity-reset Edge Function;
--   * every retired account root remains archived for continuity/audit.

begin;

alter table public.user_public_keys
  add column if not exists identity_epoch integer not null default 1;

create or replace function public.aegis_guard_account_identity_mutation_v2()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_setting('aegis.identity_mutation_authorized', true) = 'on'
     or coalesce(auth.role(), '') = 'service_role' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    if tg_op = 'TRUNCATE' then
      return null;
    end if;
    return new;
  end if;

  raise exception 'IDENTITY_MUTATION_REQUIRES_VERIFIED_RPC'
    using errcode = '42501';
end;
$$;

drop trigger if exists aegis_guard_account_identity_rows_v2
  on public.user_public_keys;
create trigger aegis_guard_account_identity_rows_v2
before insert or update or delete on public.user_public_keys
for each row execute function public.aegis_guard_account_identity_mutation_v2();

drop trigger if exists aegis_guard_account_identity_truncate_v2
  on public.user_public_keys;
create trigger aegis_guard_account_identity_truncate_v2
before truncate on public.user_public_keys
for each statement execute function public.aegis_guard_account_identity_mutation_v2();

drop policy if exists "Users can insert own keys" on public.user_public_keys;
drop policy if exists "Users can update own keys" on public.user_public_keys;

revoke insert, update, delete, truncate
  on table public.user_public_keys
  from public, anon, authenticated;
grant select on table public.user_public_keys to authenticated;

create or replace function public.publish_own_identity_key_v2(
  p_identity_key text,
  p_signing_key text,
  p_fingerprint text,
  p_binding_version integer,
  p_binding_signature text,
  p_kem_type text default 'X25519'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_existing public.user_public_keys%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  if octet_length(trim(coalesce(p_identity_key, ''))) < 40
     or octet_length(trim(coalesce(p_identity_key, ''))) > 128
     or octet_length(trim(coalesce(p_signing_key, ''))) < 40
     or octet_length(trim(coalesce(p_signing_key, ''))) > 128
     or octet_length(trim(coalesce(p_fingerprint, ''))) < 32
     or octet_length(trim(coalesce(p_fingerprint, ''))) > 160
     or octet_length(trim(coalesce(p_binding_signature, ''))) < 80
     or octet_length(trim(coalesce(p_binding_signature, ''))) > 256
     or p_binding_version is distinct from 1
     or upper(trim(coalesce(p_kem_type, ''))) <> 'X25519' then
    return jsonb_build_object('ok', false, 'code', 'IDENTITY_BUNDLE_INVALID');
  end if;

  if not public.aegis_verify_account_binding(
    trim(p_identity_key),
    trim(p_signing_key),
    trim(p_fingerprint),
    trim(p_binding_signature),
    p_binding_version
  ) then
    return jsonb_build_object('ok', false, 'code', 'IDENTITY_BINDING_INVALID');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));

  select key.*
    into v_existing
    from public.user_public_keys key
   where key.user_id = v_user
     and key.is_active = true
   order by key.created_at desc
   limit 1
   for update;

  if found then
    if v_existing.identity_key is distinct from trim(p_identity_key)
       or v_existing.signing_key is distinct from trim(p_signing_key)
       or v_existing.fingerprint is distinct from trim(p_fingerprint) then
      return jsonb_build_object(
        'ok', false,
        'code', 'IDENTITY_ROTATION_REQUIRED',
        'identity_epoch', v_existing.identity_epoch,
        'fingerprint', v_existing.fingerprint
      );
    end if;

    perform set_config('aegis.identity_mutation_authorized', 'on', true);
    update public.user_public_keys
       set identity_binding_version = 1,
           identity_binding_signature = trim(p_binding_signature),
           kem_type = 'X25519',
           updated_at = v_now
     where id = v_existing.id;

    return jsonb_build_object(
      'ok', true,
      'code', 'IDENTITY_ALREADY_PUBLISHED',
      'identity_epoch', v_existing.identity_epoch,
      'fingerprint', v_existing.fingerprint,
      'created', false
    );
  end if;

  -- Historical rows prove that this account already had an identity. Never
  -- turn a missing active row into an implicit re-key from browser state.
  if exists (
    select 1 from public.user_public_keys key where key.user_id = v_user
  ) then
    return jsonb_build_object('ok', false, 'code', 'IDENTITY_RECOVERY_REQUIRED');
  end if;

  perform set_config('aegis.identity_mutation_authorized', 'on', true);
  insert into public.user_public_keys (
    user_id,
    identity_key,
    signing_key,
    fingerprint,
    identity_binding_version,
    identity_binding_signature,
    identity_epoch,
    kem_type,
    is_active,
    created_at,
    updated_at
  ) values (
    v_user,
    trim(p_identity_key),
    trim(p_signing_key),
    trim(p_fingerprint),
    1,
    trim(p_binding_signature),
    1,
    'X25519',
    true,
    v_now,
    v_now
  );

  return jsonb_build_object(
    'ok', true,
    'code', 'IDENTITY_PUBLISHED',
    'identity_epoch', 1,
    'fingerprint', trim(p_fingerprint),
    'created', true
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'IDENTITY_PUBLICATION_CONFLICT');
end;
$$;

revoke all on function public.publish_own_identity_key_v2(text,text,text,integer,text,text)
  from public, anon;
grant execute on function public.publish_own_identity_key_v2(text,text,text,integer,text,text)
  to authenticated, service_role;

create or replace function public.replace_unrecoverable_identity_v2(
  p_user_id uuid,
  p_identity_key text,
  p_signing_key text,
  p_fingerprint text,
  p_binding_version integer,
  p_binding_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current public.user_public_keys%rowtype;
  v_next_epoch integer;
  v_now timestamptz := clock_timestamp();
begin
  if p_user_id is null then
    return jsonb_build_object('ok', false, 'code', 'USER_REQUIRED');
  end if;

  if octet_length(trim(coalesce(p_identity_key, ''))) < 40
     or octet_length(trim(coalesce(p_identity_key, ''))) > 128
     or octet_length(trim(coalesce(p_signing_key, ''))) < 40
     or octet_length(trim(coalesce(p_signing_key, ''))) > 128
     or octet_length(trim(coalesce(p_fingerprint, ''))) < 32
     or octet_length(trim(coalesce(p_fingerprint, ''))) > 160
     or octet_length(trim(coalesce(p_binding_signature, ''))) < 80
     or octet_length(trim(coalesce(p_binding_signature, ''))) > 256
     or p_binding_version is distinct from 1 then
    return jsonb_build_object('ok', false, 'code', 'IDENTITY_BUNDLE_INVALID');
  end if;

  if not public.aegis_verify_account_binding(
    trim(p_identity_key),
    trim(p_signing_key),
    trim(p_fingerprint),
    trim(p_binding_signature),
    p_binding_version
  ) then
    return jsonb_build_object('ok', false, 'code', 'IDENTITY_BINDING_INVALID');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  -- A recoverable identity must be restored, never replaced.
  if exists (select 1 from public.user_backups where user_id = p_user_id)
     or exists (select 1 from public.aegis_recovery_vaults where user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'RECOVERABLE_BACKUP_EXISTS');
  end if;

  select key.*
    into v_current
    from public.user_public_keys key
   where key.user_id = p_user_id
     and key.is_active = true
   order by key.created_at desc
   limit 1
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'ACTIVE_IDENTITY_NOT_FOUND');
  end if;

  if v_current.identity_key = trim(p_identity_key)
     and v_current.signing_key = trim(p_signing_key)
     and v_current.fingerprint = trim(p_fingerprint) then
    return jsonb_build_object(
      'ok', true,
      'code', 'IDENTITY_ALREADY_CURRENT',
      'identity_epoch', v_current.identity_epoch,
      'fingerprint', v_current.fingerprint
    );
  end if;

  select coalesce(max(key.identity_epoch), 0) + 1
    into v_next_epoch
    from public.user_public_keys key
   where key.user_id = p_user_id;
  v_next_epoch := greatest(v_next_epoch, 2);

  perform set_config('aegis.identity_mutation_authorized', 'on', true);

  update public.user_public_keys
     set is_active = false,
         updated_at = v_now
   where user_id = p_user_id
     and is_active = true;

  insert into public.user_public_keys (
    user_id,
    identity_key,
    signing_key,
    fingerprint,
    identity_binding_version,
    identity_binding_signature,
    identity_epoch,
    kem_type,
    is_active,
    created_at,
    updated_at
  ) values (
    p_user_id,
    trim(p_identity_key),
    trim(p_signing_key),
    trim(p_fingerprint),
    1,
    trim(p_binding_signature),
    v_next_epoch,
    'X25519',
    true,
    v_now,
    v_now
  );

  -- Existing device authorizations were signed by the retired account root.
  update public.user_devices
     set device_authorization_signature = null,
         routing_status = 'repairing',
         routing_error = 'ACCOUNT_IDENTITY_REPLACED',
         routing_checked_at = v_now,
         updated_at = v_now
   where user_id = p_user_id
     and revoked_at is null
     and device_authorization_signature is not null;

  return jsonb_build_object(
    'ok', true,
    'code', 'IDENTITY_REPLACED',
    'identity_epoch', v_next_epoch,
    'fingerprint', trim(p_fingerprint)
  );
end;
$$;

revoke all on function public.replace_unrecoverable_identity_v2(uuid,text,text,text,integer,text)
  from public, anon, authenticated;
grant execute on function public.replace_unrecoverable_identity_v2(uuid,text,text,text,integer,text)
  to service_role;

-- The legacy RPC trusted possession of a bearer token as password proof.
revoke all on function public.replace_own_identity_key(text,text,text,integer,text)
  from public, anon, authenticated, service_role;

revoke all on function public.aegis_guard_account_identity_mutation_v2()
  from public, anon, authenticated;

-- Canonical role assignment: any already-approved live device means the new
-- device is secondary, even while that older device is still synchronizing.
create or replace function public.finalize_device_approval_decision(
  p_user_id uuid,
  p_target_device_id text,
  p_challenge_id uuid,
  p_decision text,
  p_approver_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target public.user_devices%rowtype;
  v_live_count integer;
  v_now timestamptz := clock_timestamp();
  v_is_first boolean;
begin
  if p_user_id is null
     or trim(coalesce(p_target_device_id, '')) !~ '^dev_[a-f0-9]{32}$'
     or p_challenge_id is null
     or p_decision not in ('approve', 'reject') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_DECISION');
  end if;

  if p_approver_device_id is not null
     and p_approver_device_id <> p_target_device_id then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_EXTERNAL_APPROVER_FORBIDDEN');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select * into v_target
    from public.user_devices device
   where device.user_id = p_user_id
     and device.device_id = trim(p_target_device_id)
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND');
  end if;
  if v_target.approval_challenge_id is distinct from p_challenge_id
     or v_target.approval_status <> 'pending'
     or v_target.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_PENDING');
  end if;

  select count(*) into v_live_count
    from public.user_devices device
   where device.user_id = p_user_id
     and device.device_id <> trim(p_target_device_id)
     and device.approval_status = 'approved'
     and device.is_active = true
     and device.revoked_at is null;
  v_is_first := v_live_count = 0;

  if p_decision = 'reject' then
    update public.user_devices
       set approval_status = 'rejected',
           is_active = false,
           lifecycle_status = 'revoked',
           rejected_at = v_now,
           rejected_by = p_user_id,
           rejected_by_device_id = null,
           revoked_at = v_now,
           revoke_reason = 'user_rejected_pending_device',
           stale_at = v_now,
           binding_status = 'revoked',
           routing_status = 'unavailable',
           routing_error = 'DEVICE_REJECTED',
           updated_at = v_now
     where id = v_target.id;

    return jsonb_build_object(
      'ok', true,
      'code', 'DEVICE_REVOKED',
      'device_id', trim(p_target_device_id),
      'approver_device_id', null
    );
  end if;

  update public.user_devices
     set device_role = case when v_is_first then 'primary' else 'secondary' end,
         approval_status = 'approved',
         lifecycle_status = 'approved',
         is_active = true,
         approved_at = v_now,
         approved_by = p_user_id,
         approved_by_device_id = null,
         rejected_by_device_id = null,
         possession_verified_at = coalesce(possession_verified_at, v_now),
         routing_status = 'repairing',
         routing_error = 'DEVICE_SYNC_REQUIRED',
         updated_at = v_now
   where id = v_target.id;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_APPROVED',
    'device_id', trim(p_target_device_id),
    'device_role', case when v_is_first then 'primary' else 'secondary' end,
    'approver_device_id', null
  );
end;
$$;

revoke all on function public.finalize_device_approval_decision(uuid,text,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.finalize_device_approval_decision(uuid,text,uuid,text,text)
  to service_role;

-- The client-provided bootstrap flag is now only an assertion. The server
-- recomputes the first-device state under the same account lock and rejects any
-- mismatch. Secondary devices must carry an account-root authorization proof.
create or replace function public.approve_device_enrollment_decision(
  p_decision text,
  p_bootstrap_primary boolean,
  p_approver_device_id text,
  p_device_id text,
  p_challenge_id uuid,
  p_signature text,
  p_device_authorization_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device public.user_devices%rowtype;
  v_account public.user_public_keys%rowtype;
  v_live_count integer;
  v_is_first boolean;
  v_result jsonb;
  v_binding jsonb;
  v_binding_code text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if p_decision not in ('approve', 'reject')
     or trim(coalesce(p_approver_device_id, '')) !~ '^dev_[a-f0-9]{32}$'
     or trim(coalesce(p_device_id, '')) !~ '^dev_[a-f0-9]{32}$'
     or p_challenge_id is null
     or length(trim(coalesce(p_signature, ''))) < 80 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_APPROVAL_REQUEST');
  end if;
  if trim(p_approver_device_id) <> trim(p_device_id) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_EXTERNAL_APPROVER_FORBIDDEN');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  select * into v_device
    from public.user_devices device
   where device.user_id = v_uid
     and device.device_id = trim(p_device_id)
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND');
  end if;
  if v_device.approval_status <> 'pending'
     or v_device.is_active <> false
     or v_device.revoked_at is not null
     or v_device.approval_challenge_id is distinct from p_challenge_id then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_PENDING');
  end if;

  select count(*) into v_live_count
    from public.user_devices device
   where device.user_id = v_uid
     and device.device_id <> trim(p_device_id)
     and device.approval_status = 'approved'
     and device.is_active = true
     and device.revoked_at is null;
  v_is_first := v_live_count = 0;

  if p_bootstrap_primary is distinct from v_is_first then
    return jsonb_build_object(
      'ok', false,
      'code', 'BOOTSTRAP_STATE_MISMATCH',
      'bootstrap_primary', v_is_first
    );
  end if;

  if p_decision = 'approve' and not v_is_first then
    if length(trim(coalesce(p_device_authorization_signature, ''))) < 80 then
      return jsonb_build_object('ok', false, 'code', 'DEVICE_AUTHORIZATION_SIGNATURE_REQUIRED');
    end if;
    if v_device.device_public_key is null or v_device.device_signing_key is null then
      return jsonb_build_object('ok', false, 'code', 'DEVICE_PUBLIC_KEYS_MISSING');
    end if;

    select * into v_account
      from public.user_public_keys key
     where key.user_id = v_uid
       and key.is_active = true
     order by key.created_at desc
     limit 1
     for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'ACCOUNT_IDENTITY_NOT_FOUND');
    end if;
    if not public.aegis_verify_account_binding(
      v_account.identity_key,
      v_account.signing_key,
      v_account.fingerprint,
      v_account.identity_binding_signature,
      v_account.identity_binding_version
    ) then
      return jsonb_build_object('ok', false, 'code', 'ACCOUNT_BINDING_SIGNATURE_INVALID');
    end if;
    if not public.aegis_verify_device_authorization(
      v_uid,
      trim(p_device_id),
      v_device.device_public_key,
      v_device.device_signing_key,
      trim(p_device_authorization_signature),
      v_account.signing_key,
      v_account.fingerprint
    ) then
      return jsonb_build_object('ok', false, 'code', 'DEVICE_AUTHORIZATION_SIGNATURE_INVALID');
    end if;
  end if;

  -- Keep approval and optional binding atomic. Raising inside this sub-block
  -- rolls the approval mutation back if account binding unexpectedly fails.
  begin
    v_result := public.approve_device_enrollment_decision_pre_account_authorization(
      p_decision,
      v_is_first,
      trim(p_approver_device_id),
      trim(p_device_id),
      p_challenge_id,
      trim(p_signature)
    );

    if v_result is null or coalesce((v_result ->> 'ok')::boolean, false) is not true then
      return coalesce(
        v_result,
        jsonb_build_object('ok', false, 'code', 'DEVICE_APPROVAL_REJECTED')
      );
    end if;

    if p_decision = 'approve' and not v_is_first then
      v_binding := public.finalize_device_account_binding(
        v_uid,
        trim(p_device_id),
        trim(p_device_authorization_signature)
      );
      if v_binding is null or coalesce((v_binding ->> 'ok')::boolean, false) is not true then
        v_binding_code := coalesce(v_binding ->> 'code', 'DEVICE_ACCOUNT_BINDING_FAILED');
        raise exception 'ATOMIC_DEVICE_APPROVAL_BINDING_FAILED:%', v_binding_code;
      end if;
      v_result := v_result || jsonb_build_object(
        'binding_status', 'bound',
        'account_authorized', true
      );
    end if;
  exception
    when others then
      if sqlerrm like 'ATOMIC_DEVICE_APPROVAL_BINDING_FAILED:%' then
        return jsonb_build_object(
          'ok', false,
          'code', split_part(sqlerrm, ':', 2),
          'approval_rolled_back', true
        );
      end if;
      raise;
  end;

  return v_result || jsonb_build_object('bootstrap_primary', v_is_first);
end;
$$;

create or replace function public.approve_device_enrollment_decision(
  p_decision text,
  p_bootstrap_primary boolean,
  p_approver_device_id text,
  p_device_id text,
  p_challenge_id uuid,
  p_signature text
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.approve_device_enrollment_decision(
    p_decision,
    p_bootstrap_primary,
    p_approver_device_id,
    p_device_id,
    p_challenge_id,
    p_signature,
    null
  );
$$;

revoke all on function public.approve_device_enrollment_decision(text,boolean,text,text,uuid,text,text)
  from public, anon;
revoke all on function public.approve_device_enrollment_decision(text,boolean,text,text,uuid,text)
  from public, anon;
grant execute on function public.approve_device_enrollment_decision(text,boolean,text,text,uuid,text,text)
  to authenticated, service_role;
grant execute on function public.approve_device_enrollment_decision(text,boolean,text,text,uuid,text)
  to authenticated, service_role;

revoke all on function public.approve_device_enrollment_decision_pre_account_authorization(text,boolean,text,text,uuid,text)
  from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
