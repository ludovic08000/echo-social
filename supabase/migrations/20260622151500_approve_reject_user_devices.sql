-- Explicit E2EE device approval/rejection.
--
-- Signal/Sesame rule applied to Forsure:
--   - registration can create a pending device request;
--   - only an explicit local key unlock/link approval may promote it;
--   - pending/rejected devices must never become active through legacy upserts.

create or replace function public.approve_user_device(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_row record;
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  if length(v_device_id) < 8 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_ID');
  end if;

  select *
    into v_row
    from public.user_devices
   where user_id = v_user
     and device_id = v_device_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND');
  end if;

  if v_row.revoked_at is not null or v_row.approval_status = 'rejected' then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED_OR_REJECTED');
  end if;

  if nullif(trim(coalesce(v_row.device_public_key, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_PUBLIC_KEY_MISSING');
  end if;

  update public.user_devices
     set approval_status = 'approved',
         is_active = true,
         approved_at = coalesce(approved_at, now()),
         approved_by = coalesce(approved_by, v_user),
         rejected_at = null,
         rejected_by = null,
         last_seen_at = now(),
         updated_at = now()
   where user_id = v_user
     and device_id = v_device_id;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_APPROVED',
    'status', 'approved',
    'device_id', v_device_id
  );
end;
$$;

create or replace function public.reject_user_device(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  if length(v_device_id) < 8 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_ID');
  end if;

  update public.user_devices
     set approval_status = 'rejected',
         is_active = false,
         rejected_at = now(),
         rejected_by = v_user,
         revoke_reason = coalesce(revoke_reason, 'device_approval_rejected'),
         updated_at = now()
   where user_id = v_user
     and device_id = v_device_id
     and approval_status <> 'approved';

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND_OR_ALREADY_APPROVED');
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_REJECTED',
    'status', 'rejected',
    'device_id', v_device_id
  );
end;
$$;

revoke execute on function public.approve_user_device(text) from public;
revoke execute on function public.reject_user_device(text) from public;
grant execute on function public.approve_user_device(text) to authenticated;
grant execute on function public.reject_user_device(text) to authenticated;

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
security definer
set search_path = public
as $$
declare
  v_existing public.user_devices%rowtype;
  v_found boolean := false;
  v_has_approved boolean := false;
  v_now timestamptz := now();
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED');
  end if;

  if p_user_id is null
     or p_device_id is null
     or length(trim(p_device_id)) < 8
     or nullif(trim(coalesce(p_device_public_key, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_PAYLOAD');
  end if;

  select *
    into v_existing
    from public.user_devices
   where user_id = p_user_id
     and device_id = trim(p_device_id)
   for update;
  v_found := found;

  select exists (
    select 1
      from public.user_devices
     where user_id = p_user_id
       and approval_status = 'approved'
       and is_active = true
       and revoked_at is null
  ) into v_has_approved;

  if v_found then
    if v_existing.revoked_at is not null or v_existing.approval_status = 'rejected' then
      return jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED_OR_REJECTED');
    end if;

    if v_existing.approval_status = 'pending' then
      update public.user_devices
         set device_name = p_device_name,
             device_public_key = p_device_public_key,
             device_fingerprint = p_device_fingerprint,
             platform = p_platform,
             user_agent = p_user_agent,
             last_seen_at = v_now,
             updated_at = v_now,
             is_active = false,
             approval_requested_at = coalesce(approval_requested_at, v_now)
       where user_id = p_user_id
         and device_id = trim(p_device_id);

      return jsonb_build_object(
        'ok', false,
        'code', 'DEVICE_APPROVAL_PENDING',
        'status', 'pending',
        'device_id', trim(p_device_id)
      );
    end if;

    update public.user_devices
       set device_name = p_device_name,
           device_public_key = p_device_public_key,
           device_fingerprint = p_device_fingerprint,
           platform = p_platform,
           user_agent = p_user_agent,
           last_seen_at = v_now,
           updated_at = v_now,
           is_active = true,
           approval_status = 'approved',
           approved_at = coalesce(approved_at, v_now),
           approved_by = coalesce(approved_by, p_user_id)
     where user_id = p_user_id
       and device_id = trim(p_device_id);

    return jsonb_build_object(
      'ok', true,
      'status', 'approved',
      'device_id', trim(p_device_id),
      'already_known', true
    );
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
      trim(p_device_id),
      p_device_name,
      p_device_public_key,
      p_device_fingerprint,
      p_platform,
      p_user_agent,
      false,
      v_now,
      'pending',
      v_now
    );

    return jsonb_build_object(
      'ok', false,
      'code', 'DEVICE_APPROVAL_PENDING',
      'status', 'pending',
      'device_id', trim(p_device_id)
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
    last_seen_at,
    approval_status,
    approval_requested_at,
    approved_at,
    approved_by
  ) values (
    p_user_id,
    trim(p_device_id),
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

  return jsonb_build_object(
    'ok', true,
    'status', 'approved',
    'device_id', trim(p_device_id),
    'first_device', true
  );
end;
$$;

revoke execute on function public.register_user_device_safe(uuid, text, text, text, text, text, text) from public;
grant execute on function public.register_user_device_safe(uuid, text, text, text, text, text, text) to authenticated;
