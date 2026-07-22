-- Device lifecycle policy: only the authenticated user's explicit action in
-- the connected-devices menu may revoke or deactivate a DeviceID.
--
-- Inactivity and SPK repair are health signals, not authorization decisions.
-- They must never silently remove an iOS, Android or Windows installation from
-- the canonical Aegis route.

begin;

-- Restore non-revoked approved devices that an older automatic cleanup merely
-- marked stale or inactive. Explicitly revoked/rejected rows remain untouched.
update public.user_devices
set is_active = true,
    stale_at = null,
    revoke_reason = null,
    updated_at = now()
where revoked_at is null
  and coalesce(approval_status, 'approved') = 'approved'
  and (is_active = false or stale_at is not null);

-- Old SPK quarantine rows excluded otherwise-authorized devices from
-- get_signed_device_list(). Clear only entries whose DeviceID is still active,
-- approved and not manually revoked. A bad SPK remains unusable until repaired;
-- it does not silently become an authorization revocation.
delete from public.invalid_e2ee_devices bad
using public.user_devices device
where device.user_id = bad.user_id
  and device.device_id = bad.device_id
  and device.is_active = true
  and device.revoked_at is null
  and coalesce(device.approval_status, 'approved') = 'approved';

-- Legacy clients may still call these RPCs. Keep the signatures available but
-- turn them into authenticated no-ops so an old PWA cannot revoke devices.
create or replace function public.cleanup_stale_user_devices()
returns table(device_id text, action text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  return;
end;
$$;

create or replace function public.cleanup_stale_user_devices(
  p_stale_after interval default interval '30 days',
  p_revoke_after interval default interval '90 days'
)
returns table(device_id text, action text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  return;
end;
$$;

create or replace function public.cleanup_current_user_stale_devices(
  p_current_device_id text,
  p_stale_after interval default interval '30 days'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  return jsonb_build_object(
    'ok', true,
    'code', 'MANUAL_REVOCATION_ONLY',
    'devices_deactivated', 0,
    'spks_deactivated', 0
  );
end;
$$;

-- A bad signed prekey may be retired and regenerated, but the DeviceID itself
-- remains authorized until the user revokes it from DevicesPanel.
create or replace function public.quarantine_own_invalid_device_spk(
  p_device_id text,
  p_spk_id integer,
  p_reason text default 'invalid_device_spk_signature'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_spk_updated integer := 0;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if length(trim(coalesce(p_device_id, ''))) < 8 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_ID');
  end if;

  update public.device_signed_prekeys
  set is_active = false,
      is_last_resort = false
  where user_id = v_uid
    and device_id = trim(p_device_id)
    and (spk_id = p_spk_id or is_active = true or is_last_resort = true);
  get diagnostics v_spk_updated = row_count;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_SPK_REPAIR_REQUIRED',
    'device_id', trim(p_device_id),
    'spk_id', p_spk_id,
    'devices_deactivated', 0,
    'spks_deactivated', v_spk_updated
  );
end;
$$;

-- Historical callers of the whole-device quarantine RPC are intentionally
-- refused a routing-state mutation. Signature verification still fails closed.
create or replace function public.quarantine_own_invalid_device(
  p_device_id text,
  p_reason text default 'invalid_device_spk_signature'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if length(trim(coalesce(p_device_id, ''))) < 8 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_ID');
  end if;
  return jsonb_build_object(
    'ok', false,
    'code', 'MANUAL_DEVICE_REVOCATION_REQUIRED',
    'device_id', trim(p_device_id)
  );
end;
$$;

-- Enforce the policy even if an old client or RPC tries to mutate user_devices
-- directly. The current menu RPC writes revoke_reason='manual' atomically.
create or replace function public.guard_user_device_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.revoked_at is not null and new.is_active = true then
    raise exception 'USER_DEVICES_REACTIVATION_BLOCKED'
      using errcode = '23514',
            detail = format('Revoked DeviceID %s cannot be reactivated.', old.device_id);
  end if;

  if old.revoked_at is null
     and (
       new.revoked_at is not null
       or (old.is_active = true and new.is_active = false)
     )
     and coalesce(new.revoke_reason, '') <> 'manual' then
    raise exception 'DEVICE_REVOCATION_REQUIRES_MANUAL_MENU'
      using errcode = '23514',
            detail = format(
              'DeviceID %s may only be revoked from the connected-devices menu.',
              old.device_id
            );
  end if;

  if new.revoked_at is not null then
    new.is_active := false;
    new.is_primary := false;
    new.revoke_reason := 'manual';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_user_device_lifecycle
on public.user_devices;
create trigger trg_guard_user_device_lifecycle
before update on public.user_devices
for each row
execute function public.guard_user_device_lifecycle();

revoke all on function public.cleanup_stale_user_devices()
from public, anon;
revoke all on function public.cleanup_stale_user_devices(interval, interval)
from public, anon;
revoke all on function public.cleanup_current_user_stale_devices(text, interval)
from public, anon;
grant execute on function public.cleanup_stale_user_devices()
to authenticated;
grant execute on function public.cleanup_stale_user_devices(interval, interval)
to authenticated;
grant execute on function public.cleanup_current_user_stale_devices(text, interval)
to authenticated;

comment on function public.guard_user_device_lifecycle() is
  'Allows DeviceID deactivation/revocation only when the authenticated manual menu RPC marks revoke_reason=manual.';
comment on function public.cleanup_current_user_stale_devices(text, interval) is
  'Compatibility no-op: inactivity never revokes or deactivates a DeviceID.';

commit;
