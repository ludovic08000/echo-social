-- Harden revoked-device helper RPCs added by 20260525120000.
--
-- SECURITY:
-- The previous helper functions were SECURITY DEFINER and granted to
-- authenticated users. They must explicitly bind p_user_id to auth.uid(),
-- otherwise one authenticated account could probe or register devices for
-- another account.

create or replace function public.is_user_device_revoked(
  p_user_id uuid,
  p_device_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'not_authorized'
      using errcode = '42501';
  end if;

  return exists (
    select 1
    from public.user_devices ud
    where ud.user_id = p_user_id
      and ud.device_id = p_device_id
      and coalesce(ud.is_active, false) = false
  );
end;
$$;

create or replace function public.register_user_device_safe(
  p_user_id uuid,
  p_device_id text,
  p_device_name text default null,
  p_device_public_key text default null,
  p_device_fingerprint text default null,
  p_platform text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_revoked boolean;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    return jsonb_build_object(
      'ok', false,
      'code', 'NOT_AUTHORIZED',
      'message', 'Authenticated user does not match p_user_id'
    );
  end if;

  if p_user_id is null or p_device_id is null or length(trim(p_device_id)) < 8 then
    return jsonb_build_object(
      'ok', false,
      'code', 'INVALID_DEVICE_PAYLOAD',
      'message', 'Missing or invalid user_id/device_id'
    );
  end if;

  select public.is_user_device_revoked(p_user_id, p_device_id)
  into v_revoked;

  if v_revoked then
    return jsonb_build_object(
      'ok', false,
      'code', 'DEVICE_REVOKED',
      'message', 'This device_id was revoked and cannot be reactivated. Rotate the local device_id.'
    );
  end if;

  insert into public.user_devices (
    user_id,
    device_id,
    device_name,
    device_public_key,
    device_fingerprint,
    platform,
    user_agent,
    is_active,
    last_seen_at
  ) values (
    p_user_id,
    p_device_id,
    p_device_name,
    p_device_public_key,
    p_device_fingerprint,
    p_platform,
    p_user_agent,
    true,
    now()
  )
  on conflict (user_id, device_id)
  do update set
    device_name = excluded.device_name,
    device_public_key = excluded.device_public_key,
    device_fingerprint = excluded.device_fingerprint,
    platform = excluded.platform,
    user_agent = excluded.user_agent,
    is_active = true,
    last_seen_at = now()
  where public.user_devices.user_id = auth.uid()
    and public.user_devices.is_active = true;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'code', 'DEVICE_REVOKED_OR_LOCKED',
      'message', 'Device was not updated because it is inactive/revoked. Rotate the local device_id.'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_REGISTERED',
    'device_id', p_device_id
  );
end;
$$;

grant execute on function public.is_user_device_revoked(uuid, text) to authenticated;
grant execute on function public.register_user_device_safe(uuid, text, text, text, text, text, text) to authenticated;
