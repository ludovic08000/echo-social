-- Close legacy/status-only entrypoints around the Signal-style trust chain.
-- These functions keep their public contracts but can no longer treat a
-- non-empty signature or routing_status='ready' as sufficient proof.

begin;

-- Authenticated compatibility RPC: delegate to the cryptographically guarded
-- service-role finalizer instead of returning early for any non-empty stored
-- authorization signature.
create or replace function public.bind_device_account(
  p_device_id text,
  p_device_authorization_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if trim(coalesce(p_device_id, '')) !~ '^dev_[a-f0-9]{32}$'
     or length(trim(coalesce(p_device_authorization_signature, ''))) < 80 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_BINDING_INPUT');
  end if;

  v_result := public.finalize_device_account_binding(
    v_uid,
    trim(p_device_id),
    trim(p_device_authorization_signature)
  );

  if v_result is null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_BINDING_REJECTED');
  end if;
  return v_result;
end;
$$;

revoke all on function public.bind_device_account(text,text) from public, anon;
grant execute on function public.bind_device_account(text,text)
  to authenticated, service_role;

-- A route may become READY only if the current account binding, the current
-- device authorization, and an active Signed PreKey all verify cryptographically.
create or replace function public.mark_current_device_route_ready(p_device_id text)
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
  set routing_status = 'ready',
      routing_error = null,
      routing_checked_at = now(),
      crypto_invalid_at = null,
      crypto_invalid_reason = null,
      updated_at = now()
  where device.user_id = v_uid
    and device.device_id = v_device_id
    and device.is_active = true
    and device.revoked_at is null
    and device.stale_at is null
    and device.approval_status = 'approved'
    and device.binding_status = 'bound'
    and device.account_bound_at is not null
    and nullif(trim(device.device_public_key), '') is not null
    and nullif(trim(device.device_signing_key), '') is not null
    and nullif(trim(device.device_authorization_signature), '') is not null
    and exists (
      select 1
      from public.user_public_keys account
      where account.user_id = v_uid
        and account.is_active = true
        and account.id = (
          select current_account.id
          from public.user_public_keys current_account
          where current_account.user_id = v_uid
            and current_account.is_active = true
          order by current_account.created_at desc
          limit 1
        )
        and public.aegis_verify_account_binding(
          account.identity_key,
          account.signing_key,
          account.fingerprint,
          account.identity_binding_signature,
          account.identity_binding_version
        )
        and public.aegis_verify_device_authorization(
          device.user_id,
          device.device_id,
          device.device_public_key,
          device.device_signing_key,
          device.device_authorization_signature,
          account.signing_key,
          account.fingerprint
        )
    )
    and exists (
      select 1
      from public.device_signed_prekeys spk
      where spk.user_id = v_uid
        and spk.device_id = v_device_id
        and spk.is_active = true
        and spk.expires_at > now()
        and public.aegis_verify_signed_prekey(
          device.device_signing_key,
          spk.public_key,
          spk.signature
        )
    );

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ROUTE_INCOMPLETE');
  end if;
  return jsonb_build_object('ok', true, 'code', 'DEVICE_ROUTE_READY');
end;
$$;

revoke all on function public.mark_current_device_route_ready(text) from public, anon;
grant execute on function public.mark_current_device_route_ready(text)
  to authenticated, service_role;

-- Lifecycle READY must mean the same thing as Sesame routable, not merely that
-- a mutable status column currently says ready.
create or replace function public.complete_current_device_synchronization(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device public.user_devices%rowtype;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;

  select * into v_device
  from public.user_devices d
  where d.user_id = v_uid and d.device_id = trim(p_device_id)
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND');
  end if;

  if not exists (
    select 1
    from public.get_sesame_device_list(v_uid) route
    where route.device_id = v_device.device_id
      and route.is_routable = true
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_SYNCHRONIZATION_INCOMPLETE');
  end if;

  update public.user_devices
  set lifecycle_status = 'ready',
      updated_at = now()
  where id = v_device.id;

  return jsonb_build_object('ok', true, 'code', 'DEVICE_READY', 'device_id', v_device.device_id);
end;
$$;

revoke all on function public.complete_current_device_synchronization(text) from public, anon;
grant execute on function public.complete_current_device_synchronization(text)
  to authenticated, service_role;

-- Canonical identity lookup must never expose a status-only "ready" identity as
-- trusted. The client still independently verifies the returned signatures.
create or replace function public.get_canonical_remote_device_identity(
  p_user_id uuid,
  p_device_id text
)
returns table(
  device_id text,
  device_public_key text,
  device_signing_key text,
  device_authorization_signature text,
  approval_status text,
  binding_status text,
  routing_status text,
  is_active boolean,
  revoked_at timestamptz,
  stale_at timestamptz,
  crypto_invalid_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  if p_user_id is null or trim(coalesce(p_device_id, '')) = '' then
    raise exception 'DEVICE_TRUST_INPUT_INVALID' using errcode = '22023';
  end if;

  return query
  select
    d.device_id,
    d.device_public_key,
    d.device_signing_key,
    d.device_authorization_signature,
    d.approval_status,
    d.binding_status,
    d.routing_status,
    d.is_active,
    d.revoked_at,
    d.stale_at,
    d.crypto_invalid_at
  from public.user_devices d
  where d.user_id = p_user_id
    and d.device_id = trim(p_device_id)
    and d.stale_at is null
    and exists (
      select 1
      from public.get_sesame_device_list(p_user_id) route
      where route.device_id = d.device_id
        and route.is_routable = true
    )
  limit 1;
end;
$$;

revoke all on function public.get_canonical_remote_device_identity(uuid,text)
  from public, anon;
grant execute on function public.get_canonical_remote_device_identity(uuid,text)
  to authenticated, service_role;

-- Legacy active-device discovery is now just a projection of the verified
-- Sesame route set; callers cannot accidentally fan out to a repairing device.
create or replace function public.list_active_devices_for_user(p_user_id uuid)
returns table(
  device_id text,
  device_public_key text,
  platform text,
  last_seen_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    route.device_id,
    route.device_public_key,
    device.platform,
    route.last_seen_at
  from public.get_sesame_device_list(p_user_id) route
  join public.user_devices device
    on device.user_id = p_user_id
   and device.device_id = route.device_id
  where route.is_routable = true
    and device.stale_at is null
  order by route.last_seen_at desc nulls last;
$$;

revoke all on function public.list_active_devices_for_user(uuid) from public, anon;
grant execute on function public.list_active_devices_for_user(uuid)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
