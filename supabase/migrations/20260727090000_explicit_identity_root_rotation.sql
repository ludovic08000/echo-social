begin;

-- Explicit identity-root rotation.
--
-- publish_user_identity_root() (see 20260715210000_canonical_user_identity_root.sql)
-- deliberately refuses to overwrite an existing root when the new key differs —
-- that is the anti-impersonation guard. But no client-side flow ever calls this
-- function, so an account whose current device generated its own local identity
-- instead of inheriting the real one (no QR pairing done) gets permanently stuck:
-- every repair attempt is rejected with IDENTITY_ROOT_MISMATCH.
--
-- This RPC is the "explicit identity rotation procedure" referenced in that
-- guard's error detail. It is intentionally narrow:
--   - only the authenticated account owner can call it for their own account
--   - the new primary device must already be one of the caller's own approved,
--     active, non-revoked devices (no rotating onto an arbitrary device id)
--   - rate-limited to one rotation per account per 24h
--   - every rotation is recorded in user_identity_change_events, so it shows up
--     through the same "safety number changed" banner peers already see
create or replace function public.rotate_user_identity_root(
  p_new_primary_device_id text,
  p_new_identity_pub_b64 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_existing public.user_identity_roots%rowtype;
  v_root_exists boolean;
  v_last_rotation timestamptz;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  if p_new_primary_device_id is null
     or char_length(p_new_primary_device_id) < 8
     or p_new_identity_pub_b64 is null
     or char_length(p_new_identity_pub_b64) < 32 then
    raise exception 'INVALID_IDENTITY_ROOT' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.user_devices ud
    where ud.user_id = v_uid
      and ud.device_id = p_new_primary_device_id
      and ud.is_active = true
      and ud.approval_status = 'approved'
      and ud.revoked_at is null
  ) then
    raise exception 'NEW_PRIMARY_DEVICE_NOT_APPROVED' using errcode = '42501';
  end if;

  select * into v_existing
  from public.user_identity_roots
  where user_id = v_uid
  for update;
  v_root_exists := found;

  if v_root_exists then
    select max(observed_at) into v_last_rotation
    from public.user_identity_change_events
    where observer_user_id = v_uid
      and peer_user_id = v_uid
      and change_type = 'recovery_restore';

    if v_last_rotation is not null and v_last_rotation > now() - interval '24 hours' then
      raise exception 'IDENTITY_ROTATION_RATE_LIMITED' using errcode = '42501';
    end if;

    if v_existing.identity_pub_b64 = p_new_identity_pub_b64
       and v_existing.primary_device_id = p_new_primary_device_id then
      return jsonb_build_object('ok', true, 'rotated', false, 'generation', v_existing.generation);
    end if;
  end if;

  update public.user_devices
  set is_primary = false
  where user_id = v_uid
    and is_primary = true
    and device_id <> p_new_primary_device_id;

  update public.user_devices
  set is_primary = true
  where user_id = v_uid
    and device_id = p_new_primary_device_id;

  if v_root_exists then
    insert into public.user_identity_change_events (
      observer_user_id, peer_user_id, previous_fingerprint, new_fingerprint, change_type
    ) values (
      v_uid, v_uid, v_existing.identity_pub_b64, p_new_identity_pub_b64, 'recovery_restore'
    );

    update public.user_identity_roots
    set primary_device_id = p_new_primary_device_id,
        identity_pub_b64 = p_new_identity_pub_b64,
        generation = generation + 1,
        updated_at = now()
    where user_id = v_uid;

    return jsonb_build_object('ok', true, 'rotated', true, 'generation', v_existing.generation + 1);
  end if;

  insert into public.user_identity_roots (
    user_id, primary_device_id, identity_pub_b64
  ) values (
    v_uid, p_new_primary_device_id, p_new_identity_pub_b64
  );

  return jsonb_build_object('ok', true, 'rotated', true, 'generation', 1);
end;
$$;

revoke all on function public.rotate_user_identity_root(text, text) from public;
grant execute on function public.rotate_user_identity_root(text, text) to authenticated;

commit;
