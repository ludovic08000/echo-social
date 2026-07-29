begin;

alter table public.user_devices
  drop constraint if exists user_devices_device_identity_version_check;
alter table public.user_devices
  add constraint user_devices_device_identity_version_check
  check (device_identity_version in (1, 2));

create or replace function public.get_sesame_device_list(p_user_id uuid)
returns table (
  device_id text,
  device_public_key text,
  device_signing_key text,
  device_identity_signature text,
  device_identity_version integer,
  last_seen_at timestamptz
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    device.device_id,
    device.device_public_key,
    device.device_signing_key,
    device.device_identity_signature,
    device.device_identity_version,
    device.last_seen_at
  from public.user_devices device
  where device.user_id = p_user_id
    and device.is_active = true
    and coalesce(device.approval_status, 'approved') = 'approved'
    and device.revoked_at is null
    and device.routing_status = 'ready'
    and nullif(trim(device.device_public_key), '') is not null
    and nullif(trim(device.device_signing_key), '') is not null
    and nullif(trim(device.device_identity_signature), '') is not null
    and device.device_identity_version = 2
    and exists (
      select 1
      from public.device_signed_prekeys spk
      where spk.user_id = device.user_id
        and spk.device_id = device.device_id
        and spk.is_active = true
    )
  order by device.device_id;
$$;

revoke all on function public.get_sesame_device_list(uuid) from public, anon;
grant execute on function public.get_sesame_device_list(uuid) to authenticated;

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
     or length(coalesce(p_device_public_key, '')) not between 40 and 100
     or length(coalesce(p_device_signing_key, '')) not between 40 and 100
     or length(coalesce(p_device_identity_signature, '')) not between 80 and 180
     or p_device_identity_version <> 2 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_IDENTITY_V2');
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
    p_device_signing_key, p_device_identity_signature, 2,
    p_device_fingerprint, p_platform, p_user_agent, true, v_now,
    'approved', v_now, v_now, v_uid, null,
    'repairing', 'SIGNED_PREKEY_VALIDATION_PENDING', v_now
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
      device_identity_version = 2,
      routing_status = 'repairing',
      routing_error = 'SIGNED_PREKEY_VALIDATION_PENDING',
      routing_checked_at = v_now
  where public.user_devices.revoked_at is null
    and coalesce(public.user_devices.approval_status, 'approved') <> 'rejected';

  return jsonb_build_object(
    'ok', true,
    'code', 'ACCOUNT_AUTHORIZED_DEVICE_REGISTERED',
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

create or replace function public.mark_current_device_route_ready(p_device_id text)
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
  update public.user_devices device
  set routing_status = 'ready',
      routing_error = null,
      routing_checked_at = now()
  where device.user_id = v_uid
    and device.device_id = trim(p_device_id)
    and device.is_active = true
    and device.revoked_at is null
    and coalesce(device.approval_status, 'approved') = 'approved'
    and device.device_identity_version = 2
    and nullif(trim(device.device_public_key), '') is not null
    and nullif(trim(device.device_signing_key), '') is not null
    and nullif(trim(device.device_identity_signature), '') is not null
    and exists (
      select 1 from public.device_signed_prekeys spk
      where spk.user_id = v_uid
        and spk.device_id = trim(p_device_id)
        and spk.is_active = true
    );
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ROUTE_V2_INCOMPLETE');
  end if;
  return jsonb_build_object('ok', true, 'code', 'DEVICE_ROUTE_READY_V2');
end;
$$;

commit;
