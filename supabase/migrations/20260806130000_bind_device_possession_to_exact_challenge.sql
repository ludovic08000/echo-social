-- Bind device approval to one exact, timely-consumed enrollment challenge and
-- require proof that the browser/device owns the staged Ed25519 private key.

begin;

alter table public.device_enrollment_challenges
  add column if not exists device_possession_signature text,
  add column if not exists possession_payload_version integer;

alter table public.user_devices
  add column if not exists approval_challenge_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_devices_approval_challenge_id_fkey'
      and conrelid = 'public.user_devices'::regclass
  ) then
    alter table public.user_devices
      add constraint user_devices_approval_challenge_id_fkey
      foreign key (approval_challenge_id)
      references public.device_enrollment_challenges(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists idx_user_devices_approval_challenge
  on public.user_devices(user_id, approval_challenge_id)
  where approval_challenge_id is not null;

-- Older clients cannot complete enrollment without a proof-of-possession.
create or replace function public.complete_user_device_enrollment(
  p_challenge_id uuid,
  p_nonce text,
  p_device_public_key text,
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
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  return jsonb_build_object(
    'ok', false,
    'code', 'DEVICE_POSSESSION_PROOF_REQUIRED',
    'challenge_id', p_challenge_id
  );
end;
$$;

revoke all on function public.complete_user_device_enrollment(
  uuid,text,text,text,text,text,text,text,text
) from public, anon;
grant execute on function public.complete_user_device_enrollment(
  uuid,text,text,text,text,text,text,text,text
) to authenticated;

create or replace function public.complete_user_device_enrollment(
  p_challenge_id uuid,
  p_nonce text,
  p_device_public_key text,
  p_device_signing_key text,
  p_device_authorization_signature text,
  p_device_possession_signature text,
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
  v_now timestamptz := now();
  v_challenge public.device_enrollment_challenges%rowtype;
  v_nonce_hash text;
  v_result jsonb;
  v_device_exists boolean;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  if length(trim(coalesce(p_device_possession_signature, ''))) < 80 then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_POSSESSION_PROOF_REQUIRED');
  end if;

  select * into v_challenge
  from public.device_enrollment_challenges challenge
  where challenge.id = p_challenge_id
    and challenge.user_id = v_uid
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_CHALLENGE_NOT_FOUND');
  end if;

  if length(coalesce(p_nonce, '')) < 32 then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_INVALID_NONCE');
  end if;

  v_nonce_hash := encode(
    extensions.digest(convert_to(p_nonce, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_nonce_hash is distinct from v_challenge.nonce_hash then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_INVALID_NONCE');
  end if;

  select exists (
    select 1
    from public.user_devices device
    where device.user_id = v_uid
      and device.device_id = v_challenge.device_id
      and device.revoked_at is null
  ) into v_device_exists;

  if v_challenge.cancelled_at is not null then
    return jsonb_build_object(
      'ok', false,
      'code', 'DEVICE_ENROLLMENT_CANCELLED',
      'device_id', v_challenge.device_id
    );
  end if;

  if v_challenge.consumed_at is not null then
    if v_device_exists
       and v_challenge.possession_payload_version = 1
       and v_challenge.device_possession_signature is not distinct from trim(p_device_possession_signature) then
      update public.user_devices
      set approval_challenge_id = v_challenge.id,
          updated_at = v_now
      where user_id = v_uid
        and device_id = v_challenge.device_id
        and approval_status = 'pending'
        and revoked_at is null;

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

  if v_challenge.expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_EXPIRED');
  end if;

  v_result := public.register_user_device_safe(
    v_uid,
    v_challenge.device_id,
    v_challenge.device_name,
    p_device_public_key,
    v_challenge.device_fingerprint,
    v_challenge.platform,
    v_challenge.user_agent,
    p_device_signing_key,
    p_device_authorization_signature,
    p_account_identity_key,
    p_account_signing_key,
    p_account_fingerprint,
    p_account_binding_signature
  );

  if coalesce((v_result ->> 'ok')::boolean, false) is not true then
    return v_result || jsonb_build_object(
      'challenge_id', v_challenge.id,
      'device_id', v_challenge.device_id
    );
  end if;

  update public.device_enrollment_challenges
  set consumed_at = v_now,
      device_possession_signature = trim(p_device_possession_signature),
      possession_payload_version = 1
  where id = v_challenge.id;

  update public.user_devices
  set approval_challenge_id = v_challenge.id,
      updated_at = v_now
  where user_id = v_uid
    and device_id = v_challenge.device_id
    and approval_status = 'pending'
    and is_active = false
    and revoked_at is null;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'DEVICE_ENROLLMENT_PENDING_DEVICE_NOT_FOUND';
  end if;

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
    'routing_status', 'repairing'
  );
end;
$$;

revoke all on function public.complete_user_device_enrollment(
  uuid,text,text,text,text,text,text,text,text,text
) from public, anon;
grant execute on function public.complete_user_device_enrollment(
  uuid,text,text,text,text,text,text,text,text,text
) to authenticated;

-- Disable the previous service-role finalizer signature. It is no longer
-- sufficient because it cannot identify the exact challenge or possession proof.
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
begin
  return jsonb_build_object(
    'ok', false,
    'code', 'DEVICE_APPROVAL_CHALLENGE_BINDING_REQUIRED',
    'device_id', trim(coalesce(p_device_id, ''))
  );
end;
$$;

revoke all on function public.finalize_verified_user_device_approval(
  uuid,text,text,text,text,text,text,text,text,integer
) from public, anon, authenticated, service_role;

create or replace function public.finalize_verified_user_device_approval(
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
  v_device public.user_devices%rowtype;
  v_account public.user_public_keys%rowtype;
  v_challenge public.device_enrollment_challenges%rowtype;
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_now timestamptz := now();
  v_existing boolean := false;
begin
  if p_user_id is null
     or p_challenge_id is null
     or v_device_id !~ '^dev_[a-f0-9]{32}$'
     or length(trim(coalesce(p_device_possession_signature, ''))) < 80 then
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
  if v_device.approval_challenge_id is distinct from p_challenge_id then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_APPROVAL_CHALLENGE_CHANGED');
  end if;

  select * into v_challenge
  from public.device_enrollment_challenges challenge
  where challenge.id = p_challenge_id
    and challenge.user_id = p_user_id
    and challenge.device_id = v_device_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_APPROVAL_CHALLENGE_NOT_FOUND');
  end if;
  if v_challenge.cancelled_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_CANCELLED');
  end if;
  if v_challenge.consumed_at is null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_NOT_COMPLETED');
  end if;
  if v_challenge.consumed_at > v_challenge.expires_at then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_EXPIRED');
  end if;
  if v_challenge.possession_payload_version is distinct from 1
     or v_challenge.device_possession_signature is distinct from trim(p_device_possession_signature) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_POSSESSION_PROOF_CHANGED');
  end if;

  v_existing := v_device.approval_status = 'approved' and v_device.is_active = true;

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
          select 1
          from public.device_signed_prekeys spk
          where spk.user_id = p_user_id
            and spk.device_id = v_device_id
            and spk.is_active = true
            and spk.expires_at > v_now
        ) then 'ready'
        else 'repairing'
      end,
      routing_error = case
        when exists (
          select 1
          from public.device_signed_prekeys spk
          where spk.user_id = p_user_id
            and spk.device_id = v_device_id
            and spk.is_active = true
            and spk.expires_at > v_now
        ) then null
        else 'SIGNED_PREKEY_VALIDATION_PENDING'
      end,
      routing_checked_at = v_now
  where user_id = p_user_id
    and device_id = v_device_id;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_APPROVED',
    'challenge_id', p_challenge_id,
    'device_id', v_device_id,
    'existing', v_existing
  );
end;
$$;

revoke all on function public.finalize_verified_user_device_approval(
  uuid,uuid,text,text,text,text,text,text,text,text,text,integer
) from public, anon, authenticated;
grant execute on function public.finalize_verified_user_device_approval(
  uuid,uuid,text,text,text,text,text,text,text,text,text,integer
) to service_role;

notify pgrst, 'reload schema';

commit;
