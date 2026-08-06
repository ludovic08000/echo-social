-- Reinstall and harden the explicit post-enrollment approval RPC.
-- A server-assigned device is approved only after its one-time enrollment
-- challenge has been consumed successfully.

create or replace function public.approve_user_device(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  if v_device_id !~ '^dev_[a-f0-9]{32}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_ID');
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
    and nullif(trim(device.device_authorization_signature), '') is not null
    and exists (
      select 1
      from public.device_enrollment_challenges challenge
      where challenge.user_id = v_uid
        and challenge.device_id = v_device_id
        and challenge.consumed_at is not null
        and challenge.cancelled_at is null
    );

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_ELIGIBLE');
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_APPROVED',
    'device_id', v_device_id
  );
end;
$function$;

revoke all on function public.approve_user_device(text) from public, anon;
grant execute on function public.approve_user_device(text) to authenticated;

comment on function public.approve_user_device(text) is
  'Atomically approves the authenticated user''s server-enrolled device after its one-time challenge has been consumed.';
