-- A pending Aegis device may only be approved or rejected by another active,
-- approved device. The Edge Function verifies the approver's Ed25519 signature;
-- these service-role RPCs re-check state atomically and persist the audit link.

begin;

alter table public.user_devices
  add column if not exists approved_by_device_id text,
  add column if not exists rejected_by_device_id text;

create index if not exists idx_user_devices_pending_approval
  on public.user_devices(user_id, approval_requested_at desc)
  where approval_status = 'pending' and revoked_at is null;

create or replace function public.finalize_verified_user_device_approval_from_device(
  p_user_id uuid,
  p_approver_device_id text,
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
  v_approver public.user_devices%rowtype;
  v_result jsonb;
  v_approver_id text := trim(coalesce(p_approver_device_id, ''));
  v_target_id text := trim(coalesce(p_device_id, ''));
begin
  if p_user_id is null
     or v_approver_id !~ '^dev_[a-f0-9]{32}$'
     or v_target_id !~ '^dev_[a-f0-9]{32}$'
     or v_approver_id = v_target_id then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_SELF_APPROVAL_FORBIDDEN');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select * into v_approver
  from public.user_devices device
  where device.user_id = p_user_id
    and device.device_id = v_approver_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'APPROVER_DEVICE_NOT_FOUND');
  end if;
  if v_approver.approval_status is distinct from 'approved'
     or v_approver.is_active is distinct from true
     or v_approver.revoked_at is not null
     or v_approver.crypto_invalid_at is not null then
    return jsonb_build_object('ok', false, 'code', 'APPROVER_DEVICE_NOT_TRUSTED');
  end if;

  v_result := public.finalize_verified_user_device_approval(
    p_user_id,
    p_challenge_id,
    v_target_id,
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
    return v_result;
  end if;

  update public.user_devices
  set approved_by_device_id = v_approver_id,
      rejected_by_device_id = null,
      updated_at = now()
  where user_id = p_user_id
    and device_id = v_target_id
    and approval_status = 'approved'
    and is_active = true
    and revoked_at is null;

  return v_result || jsonb_build_object(
    'approver_device_id', v_approver_id
  );
end;
$$;

revoke all on function public.finalize_verified_user_device_approval_from_device(
  uuid,text,uuid,text,text,text,text,text,text,text,text,text,integer
) from public, anon, authenticated;
grant execute on function public.finalize_verified_user_device_approval_from_device(
  uuid,text,uuid,text,text,text,text,text,text,text,text,text,integer
) to service_role;

create or replace function public.reject_verified_user_device_enrollment(
  p_user_id uuid,
  p_approver_device_id text,
  p_challenge_id uuid,
  p_device_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_approver public.user_devices%rowtype;
  v_target public.user_devices%rowtype;
  v_approver_id text := trim(coalesce(p_approver_device_id, ''));
  v_target_id text := trim(coalesce(p_device_id, ''));
  v_now timestamptz := now();
begin
  if p_user_id is null
     or p_challenge_id is null
     or v_approver_id !~ '^dev_[a-f0-9]{32}$'
     or v_target_id !~ '^dev_[a-f0-9]{32}$'
     or v_approver_id = v_target_id then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_SELF_APPROVAL_FORBIDDEN');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select * into v_approver
  from public.user_devices device
  where device.user_id = p_user_id
    and device.device_id = v_approver_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'APPROVER_DEVICE_NOT_FOUND');
  end if;
  if v_approver.approval_status is distinct from 'approved'
     or v_approver.is_active is distinct from true
     or v_approver.revoked_at is not null
     or v_approver.crypto_invalid_at is not null then
    return jsonb_build_object('ok', false, 'code', 'APPROVER_DEVICE_NOT_TRUSTED');
  end if;

  select * into v_target
  from public.user_devices device
  where device.user_id = p_user_id
    and device.device_id = v_target_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND');
  end if;
  if v_target.approval_challenge_id is distinct from p_challenge_id then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_APPROVAL_CHALLENGE_CHANGED');
  end if;
  if v_target.approval_status is distinct from 'pending'
     or v_target.is_active is distinct from false
     or v_target.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_PENDING');
  end if;

  update public.user_devices
  set approval_status = 'rejected',
      is_active = false,
      rejected_at = v_now,
      rejected_by = p_user_id,
      rejected_by_device_id = v_approver_id,
      approved_at = null,
      approved_by = null,
      approved_by_device_id = null,
      revoked_at = v_now,
      revoke_reason = 'USER_REJECTED_DEVICE_ENROLLMENT',
      stale_at = v_now,
      routing_status = 'error',
      routing_error = 'DEVICE_REJECTED_AND_REVOKED',
      routing_checked_at = v_now,
      updated_at = v_now
  where user_id = p_user_id
    and device_id = v_target_id;

  update public.device_enrollment_challenges
  set cancelled_at = coalesce(cancelled_at, v_now),
      cancel_reason = coalesce(cancel_reason, 'rejected_by_trusted_device')
  where id = p_challenge_id
    and user_id = p_user_id
    and device_id = v_target_id;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_REVOKED',
    'device_id', v_target_id,
    'challenge_id', p_challenge_id,
    'approver_device_id', v_approver_id
  );
end;
$$;

revoke all on function public.reject_verified_user_device_enrollment(
  uuid,text,uuid,text
) from public, anon, authenticated;
grant execute on function public.reject_verified_user_device_enrollment(
  uuid,text,uuid,text
) to service_role;

notify pgrst, 'reload schema';

commit;
