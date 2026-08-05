begin;

do $$
declare
  v_user_id constant uuid := 'ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid;
  v_device_id constant text := 'dbd1c32a42c588b6d57a235f55ea63ac';
begin
  update public.user_devices
  set is_active = false,
      revoked_at = coalesce(revoked_at, now()),
      revoke_reason = 'manual',
      approval_status = 'rejected',
      rejected_at = coalesce(rejected_at, now()),
      rejected_by = coalesce(rejected_by, user_id),
      stale_at = coalesce(stale_at, now()),
      crypto_invalid_at = coalesce(crypto_invalid_at, now()),
      crypto_invalid_reason = 'ios_must_receive_server_assigned_device_id',
      routing_status = 'unavailable',
      routing_error = 'DEVICE_ID_COLLISION_REVOKED',
      routing_checked_at = now(),
      updated_at = now()
  where user_id = v_user_id
    and device_id = v_device_id;

  delete from public.device_signed_prekeys
  where user_id = v_user_id
    and device_id = v_device_id;

  delete from public.device_one_time_prekeys
  where user_id = v_user_id
    and device_id = v_device_id;

  delete from public.e2ee_session_sync
  where user_id = v_user_id
    and device_id = v_device_id;

  delete from public.user_sender_certificates
  where user_id = v_user_id
    and device_id = v_device_id;

  delete from public.user_device_signatures
  where user_id = v_user_id
    and (device_id = v_device_id or primary_device_id = v_device_id);

  update public.device_enrollment_challenges
  set cancelled_at = coalesce(cancelled_at, now()),
      cancel_reason = coalesce(cancel_reason, 'cross_platform_device_id_collision')
  where user_id = v_user_id
    and device_id = v_device_id
    and consumed_at is null
    and cancelled_at is null;

  insert into public.invalid_e2ee_devices (
    user_id,
    device_id,
    reason,
    created_at
  ) values (
    v_user_id,
    v_device_id,
    'cross_platform_device_id_collision',
    now()
  )
  on conflict (user_id, device_id) do update
  set reason = excluded.reason,
      created_at = excluded.created_at;
end;
$$;

commit;