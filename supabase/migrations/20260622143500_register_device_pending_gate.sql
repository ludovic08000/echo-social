-- Register-device approval gate.
-- This function is intentionally small: it does not approve a second/new
-- device automatically. Existing approved devices can refresh metadata.

create or replace function public.register_user_device_safe(
  p_user_id uuid,
  p_device_id text,
  p_device_name text,
  p_device_public_key text,
  p_device_fingerprint text default null,
  p_platform text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_existing record;
  v_has_approved boolean := false;
  v_now timestamptz := now();
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED');
  end if;

  select * into v_existing
  from public.user_devices
  where user_id = p_user_id and device_id = p_device_id
  limit 1;

  select exists (
    select 1
    from public.user_devices
    where user_id = p_user_id
      and approval_status = 'approved'
      and is_active = true
      and revoked_at is null
  ) into v_has_approved;

  if v_existing.device_id is not null then
    if v_existing.revoked_at is not null or v_existing.approval_status = 'rejected' then
      return jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED_OR_REJECTED');
    end if;

    if v_existing.approval_status = 'pending' then
      update public.user_devices
      set
        device_name = p_device_name,
        device_public_key = p_device_public_key,
        device_fingerprint = p_device_fingerprint,
        platform = p_platform,
        user_agent = p_user_agent,
        last_seen_at = v_now,
        is_active = false,
        approval_requested_at = coalesce(approval_requested_at, v_now)
      where user_id = p_user_id and device_id = p_device_id;

      return jsonb_build_object('ok', false, 'code', 'DEVICE_APPROVAL_PENDING', 'status', 'pending', 'device_id', p_device_id);
    end if;

    update public.user_devices
    set
      device_name = p_device_name,
      device_public_key = p_device_public_key,
      device_fingerprint = p_device_fingerprint,
      platform = p_platform,
      user_agent = p_user_agent,
      last_seen_at = v_now,
      is_active = true,
      approval_status = 'approved',
      approved_at = coalesce(approved_at, v_now),
      approved_by = coalesce(approved_by, p_user_id)
    where user_id = p_user_id and device_id = p_device_id;

    return jsonb_build_object('ok', true, 'status', 'approved', 'device_id', p_device_id, 'already_known', true);
  end if;

  if v_has_approved then
    insert into public.user_devices (
      user_id,
      device_id,
      device_name,
      device_public_key,
      device_fingerprint,
      platform,
      user_agent,
      is_active,
      last_seen_at,
      approval_status,
      approval_requested_at
    ) values (
      p_user_id,
      p_device_id,
      p_device_name,
      p_device_public_key,
      p_device_fingerprint,
      p_platform,
      p_user_agent,
      false,
      v_now,
      'pending',
      v_now
    )
    on conflict (user_id, device_id) do update set
      device_name = excluded.device_name,
      device_public_key = excluded.device_public_key,
      device_fingerprint = excluded.device_fingerprint,
      platform = excluded.platform,
      user_agent = excluded.user_agent,
      is_active = false,
      last_seen_at = excluded.last_seen_at,
      approval_status = 'pending',
      approval_requested_at = coalesce(public.user_devices.approval_requested_at, excluded.approval_requested_at);

    return jsonb_build_object('ok', false, 'code', 'DEVICE_APPROVAL_PENDING', 'status', 'pending', 'device_id', p_device_id);
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
    last_seen_at,
    approval_status,
    approval_requested_at,
    approved_at,
    approved_by
  ) values (
    p_user_id,
    p_device_id,
    p_device_name,
    p_device_public_key,
    p_device_fingerprint,
    p_platform,
    p_user_agent,
    true,
    v_now,
    'approved',
    v_now,
    v_now,
    p_user_id
  );

  return jsonb_build_object('ok', true, 'status', 'approved', 'device_id', p_device_id, 'first_device', true);
end;
$$;
