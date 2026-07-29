begin;

-- Compatibility repair for clients that publish a complete per-device identity.
-- Safe to run repeatedly after older or partially-applied Aegis migrations.
alter table public.user_devices
  add column if not exists device_signing_key text,
  add column if not exists device_identity_signature text,
  add column if not exists device_identity_version integer not null default 1;

alter table public.user_devices
  drop constraint if exists user_devices_device_identity_version_check;
alter table public.user_devices
  add constraint user_devices_device_identity_version_check
  check (device_identity_version = 1);

drop function if exists public.register_user_device_safe(
  uuid, text, text, text, text, text, text
);
drop function if exists public.register_user_device_safe(
  uuid, text, text, text, text, text, text, text, text, integer
);

create function public.register_user_device_safe(
  p_user_id uuid,
  p_device_id text,
  p_device_name text,
  p_device_public_key text,
  p_device_fingerprint text,
  p_platform text,
  p_user_agent text,
  p_device_signing_key text,
  p_device_identity_signature text,
  p_device_identity_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_existing public.user_devices%rowtype;
  v_now timestamptz := now();
begin
  if v_uid is null or p_user_id is distinct from v_uid then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  if length(v_device_id) < 8
     or nullif(trim(coalesce(p_device_public_key, '')), '') is null
     or nullif(trim(coalesce(p_device_signing_key, '')), '') is null
     or nullif(trim(coalesce(p_device_identity_signature, '')), '') is null
     or p_device_identity_version <> 1 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_IDENTITY');
  end if;

  select * into v_existing
  from public.user_devices
  where user_id = v_uid and device_id = v_device_id
  for update;

  if found and (
    v_existing.revoked_at is not null
    or v_existing.approval_status = 'rejected'
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED_OR_REJECTED');
  end if;

  if found and (
    v_existing.device_public_key is distinct from p_device_public_key
    or (
      v_existing.device_signing_key is not null
      and v_existing.device_signing_key is distinct from p_device_signing_key
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_IDENTITY_MISMATCH');
  end if;

  insert into public.user_devices (
    user_id, device_id, device_name, device_public_key,
    device_signing_key, device_identity_signature, device_identity_version,
    device_fingerprint, platform, user_agent, is_active, last_seen_at,
    approval_status, approval_requested_at, approved_at, approved_by,
    stale_at, routing_status, routing_error, routing_checked_at
  ) values (
    v_uid, v_device_id, p_device_name, p_device_public_key,
    p_device_signing_key, p_device_identity_signature, 1,
    p_device_fingerprint, p_platform, p_user_agent, true, v_now,
    'approved', v_now, v_now, v_uid,
    null, 'repairing', 'SIGNED_PREKEY_VALIDATION_PENDING', v_now
  )
  on conflict (user_id, device_id) do update
  set device_name = excluded.device_name,
      device_fingerprint = excluded.device_fingerprint,
      platform = excluded.platform,
      user_agent = excluded.user_agent,
      last_seen_at = v_now,
      updated_at = v_now,
      is_active = true,
      approval_status = 'approved',
      approved_at = coalesce(public.user_devices.approved_at, v_now),
      approved_by = coalesce(public.user_devices.approved_by, v_uid),
      stale_at = null,
      device_signing_key = excluded.device_signing_key,
      device_identity_signature = excluded.device_identity_signature,
      device_identity_version = 1
  where public.user_devices.revoked_at is null
    and coalesce(public.user_devices.approval_status, 'approved') <> 'rejected';

  return jsonb_build_object(
    'ok', true,
    'code', 'SESAME_DEVICE_REGISTERED',
    'device_id', v_device_id
  );
end;
$$;

revoke all on function public.register_user_device_safe(
  uuid, text, text, text, text, text, text, text, text, integer
) from public, anon;

grant execute on function public.register_user_device_safe(
  uuid, text, text, text, text, text, text, text, text, integer
) to authenticated;

do $$
begin
  if to_regprocedure(
    'public.register_user_device_safe(uuid,text,text,text,text,text,text,text,text,integer)'
  ) is null then
    raise exception 'REGISTER_USER_DEVICE_SAFE_REPAIR_FAILED';
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;
