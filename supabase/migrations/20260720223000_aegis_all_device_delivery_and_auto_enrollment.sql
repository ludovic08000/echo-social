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
  p_device_name text,
  p_device_public_key text,
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
