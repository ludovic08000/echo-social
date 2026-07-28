begin;

alter table public.user_devices
  add column if not exists device_signing_key text,
  add column if not exists device_identity_signature text,
  add column if not exists device_identity_version integer not null default 1;

alter table public.user_devices
  drop constraint if exists user_devices_device_identity_version_check;
alter table public.user_devices
  add constraint user_devices_device_identity_version_check
  check (device_identity_version = 1);

-- Route versions change whenever a per-device identity or authorization state
-- changes. No primary-device state participates in Sesame routing.
create or replace function public.trg_bump_aegis_device_route()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  v_user_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  if tg_op <> 'UPDATE' or (
    old.device_id,
    old.device_public_key,
    old.device_signing_key,
    old.device_identity_signature,
    old.device_identity_version,
    old.is_active,
    old.approval_status,
    old.revoked_at,
    old.routing_status
  ) is distinct from (
    new.device_id,
    new.device_public_key,
    new.device_signing_key,
    new.device_identity_signature,
    new.device_identity_version,
    new.is_active,
    new.approval_status,
    new.revoked_at,
    new.routing_status
  ) then
    perform public.bump_aegis_user_route_version(v_user_id);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists bump_aegis_device_route on public.user_devices;
create trigger bump_aegis_device_route
after insert or update or delete on public.user_devices
for each row execute function public.trg_bump_aegis_device_route();

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
    and device.device_identity_version = 1
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

-- Existing atomic-send SQL calls this function name. Its trust semantics are
-- replaced completely: it now projects the Sesame registry and never consults
-- a root, a companion signature, or an is_primary flag.
create or replace function public.get_signed_device_list(p_user_id uuid)
returns table (
  device_id text,
  device_public_key text,
  is_primary boolean,
  primary_device_id text,
  primary_pub_b64 text,
  signature_b64 text,
  signed_at timestamptz
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    device.device_id,
    device.device_public_key,
    false,
    null::text,
    device.device_signing_key,
    device.device_identity_signature,
    device.last_seen_at
  from public.get_sesame_device_list(p_user_id) device;
$$;

revoke all on function public.get_signed_device_list(uuid) from public, anon;
grant execute on function public.get_signed_device_list(uuid) to authenticated;

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
    and nullif(trim(device.device_public_key), '') is not null
    and nullif(trim(device.device_signing_key), '') is not null
    and nullif(trim(device.device_identity_signature), '') is not null
    and device.device_identity_version = 1
    and exists (
      select 1 from public.device_signed_prekeys spk
      where spk.user_id = v_uid
        and spk.device_id = trim(p_device_id)
        and spk.is_active = true
    );
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ROUTE_INCOMPLETE');
  end if;
  return jsonb_build_object('ok', true, 'code', 'DEVICE_ROUTE_READY');
end;
$$;

-- The old root/signature data is no longer an authority. Keep no callable
-- rotation or publication path that could reintroduce a primary device.
drop function if exists public.publish_user_identity_root(text, text);
drop function if exists public.rotate_user_identity_root(text, text);
do $$
begin
  if to_regclass('public.user_identity_roots') is not null then
    execute 'drop trigger if exists bump_aegis_root_route on public.user_identity_roots';
  end if;
  if to_regclass('public.user_device_signatures') is not null then
    execute 'drop trigger if exists bump_aegis_signature_route on public.user_device_signatures';
  end if;
end;
$$;
drop table if exists public.user_device_signatures cascade;
drop table if exists public.user_identity_roots cascade;
drop table if exists public.device_primary_repair_requests cascade;

drop trigger if exists trg_aegis_reconcile_device_root on public.user_devices;
drop function if exists public.trg_aegis_reconcile_device_root();
drop function if exists public.ensure_primary_device_exists(uuid);
alter table public.user_devices drop column if exists is_primary cascade;

create or replace function public.approve_user_device(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  update public.user_devices device
  set approval_status = 'approved',
      is_active = true,
      approved_at = coalesce(device.approved_at, now()),
      approved_by = coalesce(device.approved_by, v_uid),
      rejected_at = null,
      rejected_by = null,
      stale_at = null,
      last_seen_at = now(),
      updated_at = now()
  where device.user_id = v_uid
    and device.device_id = v_device_id
    and device.revoked_at is null
    and coalesce(device.approval_status, 'approved') <> 'rejected'
    and nullif(trim(device.device_public_key), '') is not null
    and nullif(trim(device.device_signing_key), '') is not null
    and nullif(trim(device.device_identity_signature), '') is not null;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_ELIGIBLE');
  end if;
  return jsonb_build_object(
    'ok', true, 'code', 'DEVICE_APPROVED', 'device_id', v_device_id
  );
end;
$$;

drop function if exists public.revoke_user_device(text);
drop function if exists public.revoke_user_device(text, text);
create function public.revoke_user_device(
  p_device_id text,
  p_replacement_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  update public.user_devices device
  set is_active = false,
      revoked_at = now(),
      revoke_reason = 'manual',
      stale_at = coalesce(device.stale_at, now()),
      routing_status = 'unavailable',
      routing_error = 'DEVICE_REVOKED',
      routing_checked_at = now(),
      updated_at = now()
  where device.user_id = v_uid
    and device.device_id = v_device_id
    and device.revoked_at is null;
  if not found then
    raise exception 'DEVICE_NOT_FOUND_OR_ALREADY_REVOKED' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'ok', true, 'device_id', v_device_id, 'status', 'revoked'
  );
end;
$$;

create or replace function public.guard_user_device_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.revoked_at is not null and new.is_active = true then
    raise exception 'USER_DEVICES_REACTIVATION_BLOCKED' using errcode = '23514';
  end if;
  if old.revoked_at is null
     and (new.revoked_at is not null or (old.is_active and not new.is_active))
     and coalesce(new.revoke_reason, '') <> 'manual' then
    raise exception 'DEVICE_REVOCATION_REQUIRES_MANUAL_MENU'
      using errcode = '23514';
  end if;
  if new.revoked_at is not null then
    new.is_active := false;
    new.revoke_reason := 'manual';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_user_device_lifecycle on public.user_devices;
create trigger trg_guard_user_device_lifecycle
before update on public.user_devices
for each row execute function public.guard_user_device_lifecycle();

revoke all on function public.approve_user_device(text) from public, anon;
grant execute on function public.approve_user_device(text) to authenticated;
revoke all on function public.revoke_user_device(text, text) from public, anon;
grant execute on function public.revoke_user_device(text, text) to authenticated;

commit;
