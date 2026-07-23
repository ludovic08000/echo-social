-- Aegis all-device delivery and password-authenticated device enrollment.
--
-- Security contract:
--   * an authenticated account session may enroll its current installation;
--   * explicitly revoked/rejected routing identities remain permanently denied;
--   * every canonical signed device receives one capsule before the parent
--     message transaction can commit.

begin;

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
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_existing public.user_devices%rowtype;
  v_now timestamptz := now();
begin
  if v_uid is null or v_uid <> p_user_id then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHORIZED');
  end if;

  if length(v_device_id) < 8
     or nullif(trim(coalesce(p_device_public_key, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_PAYLOAD');
  end if;

  select * into v_existing
  from public.user_devices
  where user_id = v_uid
    and device_id = v_device_id
  for update;

  if found and (
    v_existing.revoked_at is not null
    or v_existing.approval_status = 'rejected'
  ) then
    return jsonb_build_object(
      'ok', false,
      'code', 'DEVICE_REVOKED_OR_REJECTED',
      'device_id', v_device_id
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
    approved_by,
    stale_at
  ) values (
    v_uid,
    v_device_id,
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
    v_uid,
    null
  )
  on conflict (user_id, device_id) do update
  set device_name = excluded.device_name,
      device_public_key = excluded.device_public_key,
      device_fingerprint = excluded.device_fingerprint,
      platform = excluded.platform,
      user_agent = excluded.user_agent,
      is_active = true,
      last_seen_at = v_now,
      updated_at = v_now,
      approval_status = 'approved',
      approval_requested_at = coalesce(
        public.user_devices.approval_requested_at,
        v_now
      ),
      approved_at = coalesce(public.user_devices.approved_at, v_now),
      approved_by = coalesce(public.user_devices.approved_by, v_uid),
      stale_at = null
  where public.user_devices.revoked_at is null
    and coalesce(public.user_devices.approval_status, 'approved') <> 'rejected';

  if not found then
    return jsonb_build_object(
      'ok', false,
      'code', 'DEVICE_REVOKED_OR_REJECTED',
      'device_id', v_device_id
    );
  end if;

  perform public.ensure_primary_device_exists(v_uid);

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_REGISTERED_AND_APPROVED',
    'status', 'approved',
    'device_id', v_device_id
  );
end;
$$;

revoke all on function public.register_user_device_safe(
  uuid, text, text, text, text, text, text
) from public, anon;
grant execute on function public.register_user_device_safe(
  uuid, text, text, text, text, text, text
) to authenticated;

-- The Aegis RPC writes the parent and its device copies in one transaction.
-- This deferred assertion runs after all rows have been inserted, but before
-- that transaction commits. A missing iOS, Android or Windows capsule rolls
-- back the parent as well, so no recipient can receive an empty bubble.
create or replace function public.trg_aegis_require_all_device_copies()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conversation_id uuid;
  v_body_kind text;
  v_missing_count integer := 0;
  v_unexpected_count integer := 0;
begin
  select m.conversation_id, m.body_kind
    into v_conversation_id, v_body_kind
  from public.messages m
  where m.id = new.message_id;

  if not found or v_body_kind <> 'multi_device' then
    return null;
  end if;

  with expected as (
    select distinct
      cp.user_id as recipient_user_id,
      dl.device_id as recipient_device_id
    from public.conversation_participants cp
    cross join lateral public.get_signed_device_list(cp.user_id) dl
    where cp.conversation_id = v_conversation_id
      and not (
        cp.user_id = new.sender_user_id
        and dl.device_id = new.sender_device_id
      )
  )
  select count(*) into v_missing_count
  from expected e
  where not exists (
    select 1
    from public.message_device_copies actual
    where actual.message_id = new.message_id
      and actual.recipient_user_id = e.recipient_user_id
      and actual.recipient_device_id = e.recipient_device_id
  );

  with expected as (
    select distinct
      cp.user_id as recipient_user_id,
      dl.device_id as recipient_device_id
    from public.conversation_participants cp
    cross join lateral public.get_signed_device_list(cp.user_id) dl
    where cp.conversation_id = v_conversation_id
      and not (
        cp.user_id = new.sender_user_id
        and dl.device_id = new.sender_device_id
      )
  )
  select count(*) into v_unexpected_count
  from public.message_device_copies actual
  where actual.message_id = new.message_id
    and not exists (
      select 1
      from expected e
      where e.recipient_user_id = actual.recipient_user_id
        and e.recipient_device_id = actual.recipient_device_id
    );

  if v_missing_count > 0 or v_unexpected_count > 0 then
    raise exception 'E2EE_DEVICE_LIST_STALE'
      using errcode = '23514',
            detail = format(
              'Aegis all-device delivery mismatch: %s missing, %s unexpected.',
              v_missing_count,
              v_unexpected_count
            );
  end if;

  return null;
end;
$$;

revoke all on function public.trg_aegis_require_all_device_copies()
from public, anon, authenticated;

drop trigger if exists aegis_require_all_device_copies
on public.message_device_copies;

create constraint trigger aegis_require_all_device_copies
after insert on public.message_device_copies
deferrable initially deferred
for each row
execute function public.trg_aegis_require_all_device_copies();

comment on function public.register_user_device_safe(
  uuid, text, text, text, text, text, text
) is 'Atomically registers and approves the authenticated account device; revoked/rejected IDs remain denied.';

comment on function public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text
) is 'Aegis v1 atomic send with commit-time coverage of every canonical signed device.';

commit;
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
-- Coverage must be asserted from the parent row. A trigger attached only to
-- message_device_copies never fires when a buggy/old sender inserts zero rows.
begin;

drop trigger if exists aegis_require_all_device_copies
on public.message_device_copies;

create or replace function public.trg_aegis_require_exact_device_copies()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sender_device_id text;
  v_missing_count integer := 0;
  v_unexpected_count integer := 0;
  v_duplicate_count integer := 0;
begin
  if new.body_kind <> 'multi_device' then
    return null;
  end if;

  select min(c.sender_device_id)
    into v_sender_device_id
  from public.message_device_copies c
  where c.message_id = new.id
    and c.sender_user_id = new.sender_id;

  if v_sender_device_id is null or length(trim(v_sender_device_id)) < 8 then
    raise exception 'E2EE_DEVICE_COPIES_UNAVAILABLE'
      using errcode = '23514',
            detail = 'Aegis parent has no sender-bound device copy set.';
  end if;

  select count(*) - count(distinct (c.recipient_user_id, c.recipient_device_id))
    into v_duplicate_count
  from public.message_device_copies c
  where c.message_id = new.id;

  with expected as (
    select distinct
      cp.user_id as recipient_user_id,
      dl.device_id as recipient_device_id
    from public.conversation_participants cp
    cross join lateral public.get_signed_device_list(cp.user_id) dl
    where cp.conversation_id = new.conversation_id
      and not (
        cp.user_id = new.sender_id
        and dl.device_id = v_sender_device_id
      )
  )
  select count(*)
    into v_missing_count
  from expected e
  where not exists (
    select 1
    from public.message_device_copies actual
    where actual.message_id = new.id
      and actual.recipient_user_id = e.recipient_user_id
      and actual.recipient_device_id = e.recipient_device_id
      and actual.sender_user_id = new.sender_id
      and actual.sender_device_id = v_sender_device_id
  );

  with expected as (
    select distinct
      cp.user_id as recipient_user_id,
      dl.device_id as recipient_device_id
    from public.conversation_participants cp
    cross join lateral public.get_signed_device_list(cp.user_id) dl
    where cp.conversation_id = new.conversation_id
      and not (
        cp.user_id = new.sender_id
        and dl.device_id = v_sender_device_id
      )
  )
  select count(*)
    into v_unexpected_count
  from public.message_device_copies actual
  where actual.message_id = new.id
    and (
      actual.sender_user_id <> new.sender_id
      or actual.sender_device_id <> v_sender_device_id
      or not exists (
        select 1
        from expected e
        where e.recipient_user_id = actual.recipient_user_id
          and e.recipient_device_id = actual.recipient_device_id
      )
    );

  if v_missing_count > 0
     or v_unexpected_count > 0
     or v_duplicate_count > 0 then
    raise exception 'E2EE_DEVICE_LIST_STALE'
      using errcode = '23514',
            detail = format(
              'Aegis exact-device delivery mismatch: %s missing, %s unexpected, %s duplicate.',
              v_missing_count,
              v_unexpected_count,
              v_duplicate_count
            );
  end if;

  return null;
end;
$$;

revoke all on function public.trg_aegis_require_exact_device_copies()
from public, anon, authenticated;

drop trigger if exists aegis_require_exact_device_copies
on public.messages;

create constraint trigger aegis_require_exact_device_copies
after insert on public.messages
deferrable initially deferred
for each row
execute function public.trg_aegis_require_exact_device_copies();

comment on function public.trg_aegis_require_exact_device_copies() is
  'Rejects every Aegis parent unless its committed copy set exactly covers the current canonical signed device route.';

commit;
