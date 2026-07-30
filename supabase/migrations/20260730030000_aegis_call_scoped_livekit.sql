begin;

create extension if not exists pgcrypto;

alter table public.active_calls
  add column if not exists room_name text,
  add column if not exists caller_device_id text,
  add column if not exists protocol_version integer not null default 1;

update public.active_calls
set room_name = 'legacy-call-' || id::text
where room_name is null;

alter table public.active_calls
  alter column room_name set not null;

create unique index if not exists active_calls_room_name_uidx
  on public.active_calls(room_name);

create table if not exists public.aegis_call_invitations (
  call_id uuid not null references public.active_calls(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_device_id text not null,
  encrypted_call_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  primary key (call_id, recipient_device_id),
  unique (call_id, recipient_user_id, recipient_device_id),
  check (length(recipient_device_id) >= 8),
  check (encrypted_call_key like 'aegis-call-v1.%')
);

create index if not exists aegis_call_invitations_recipient_idx
  on public.aegis_call_invitations(recipient_user_id, recipient_device_id, status, created_at desc);

alter table public.aegis_call_invitations enable row level security;

revoke all on table public.aegis_call_invitations from public, anon;
grant select on table public.aegis_call_invitations to authenticated;

drop policy if exists aegis_call_invitation_recipient_read on public.aegis_call_invitations;
create policy aegis_call_invitation_recipient_read
on public.aegis_call_invitations
for select
to authenticated
using (recipient_user_id = auth.uid());

create or replace function public.aegis_call_create(
  p_call_id uuid,
  p_conversation_id uuid,
  p_call_type text,
  p_caller_device_id text,
  p_invitee_ids uuid[],
  p_invitations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_invitees uuid[];
  v_first_invitee uuid;
  v_expected_count integer;
  v_supplied_count integer;
  v_room_name text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if p_call_id is null or p_conversation_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CALL_ID');
  end if;
  if p_call_type not in ('audio', 'video') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CALL_TYPE');
  end if;
  if length(trim(coalesce(p_caller_device_id, ''))) < 8 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CALLER_DEVICE');
  end if;
  if jsonb_typeof(p_invitations) is distinct from 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INVITATIONS');
  end if;

  select array_agg(distinct invitee order by invitee)
  into v_invitees
  from unnest(coalesce(p_invitee_ids, array[]::uuid[])) invitee
  where invitee is not null and invitee <> v_uid;

  if coalesce(cardinality(v_invitees), 0) < 1 or cardinality(v_invitees) > 7 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INVITEE_COUNT');
  end if;
  v_first_invitee := v_invitees[1];

  if not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id and cp.user_id = v_uid
  ) then
    return jsonb_build_object('ok', false, 'code', 'CALLER_NOT_IN_CONVERSATION');
  end if;

  if exists (
    select 1
    from unnest(v_invitees) invitee
    where not exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = p_conversation_id and cp.user_id = invitee
    )
    and not exists (
      select 1 from public.friendships friendship
      where friendship.status = 'accepted'
        and (
          (friendship.requester_id = v_uid and friendship.addressee_id = invitee)
          or (friendship.addressee_id = v_uid and friendship.requester_id = invitee)
        )
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVITEE_NOT_AUTHORIZED');
  end if;

  if not exists (
    select 1 from public.user_devices device
    where device.user_id = v_uid
      and device.device_id = p_caller_device_id
      and device.is_active = true
      and device.revoked_at is null
      and coalesce(device.approval_status, 'approved') = 'approved'
      and coalesce(device.routing_status, 'repairing') <> 'unavailable'
      and nullif(trim(device.device_authorization_signature), '') is not null
  ) then
    return jsonb_build_object('ok', false, 'code', 'CALLER_DEVICE_NOT_AUTHORIZED');
  end if;

  with expected as (
    select device.user_id, device.device_id
    from public.user_devices device
    where device.user_id = any(v_invitees)
      and device.is_active = true
      and device.revoked_at is null
      and coalesce(device.approval_status, 'approved') = 'approved'
      and coalesce(device.routing_status, 'repairing') <> 'unavailable'
      and nullif(trim(device.device_public_key), '') is not null
      and nullif(trim(device.device_authorization_signature), '') is not null
  ), supplied as (
    select
      (entry->>'recipient_user_id')::uuid as user_id,
      trim(entry->>'recipient_device_id') as device_id,
      entry->>'encrypted_call_key' as encrypted_call_key
    from jsonb_array_elements(p_invitations) entry
  )
  select (select count(*) from expected), (select count(*) from supplied)
  into v_expected_count, v_supplied_count;

  if v_expected_count = 0 or v_expected_count <> v_supplied_count then
    return jsonb_build_object('ok', false, 'code', 'INCOMPLETE_CALL_DEVICE_FANOUT');
  end if;

  if exists (
    with expected as (
      select device.user_id, device.device_id
      from public.user_devices device
      where device.user_id = any(v_invitees)
        and device.is_active = true
        and device.revoked_at is null
        and coalesce(device.approval_status, 'approved') = 'approved'
        and coalesce(device.routing_status, 'repairing') <> 'unavailable'
        and nullif(trim(device.device_public_key), '') is not null
        and nullif(trim(device.device_authorization_signature), '') is not null
    ), supplied as (
      select
        (entry->>'recipient_user_id')::uuid as user_id,
        trim(entry->>'recipient_device_id') as device_id,
        entry->>'encrypted_call_key' as encrypted_call_key
      from jsonb_array_elements(p_invitations) entry
    )
    (select user_id, device_id from expected
     except
     select user_id, device_id from supplied)
    union all
    (select user_id, device_id from supplied
     except
     select user_id, device_id from expected)
  ) then
    return jsonb_build_object('ok', false, 'code', 'CALL_DEVICE_ROUTE_MISMATCH');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_invitations) entry
    where length(trim(coalesce(entry->>'recipient_device_id', ''))) < 8
       or coalesce(entry->>'encrypted_call_key', '') not like 'aegis-call-v1.%'
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CALL_KEY_ENVELOPE');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_call_id::text, 0));
  if exists (select 1 from public.active_calls where id = p_call_id) then
    return jsonb_build_object('ok', false, 'code', 'CALL_ID_ALREADY_EXISTS');
  end if;

  v_room_name := 'call-' || p_call_id::text;

  insert into public.active_calls (
    id, conversation_id, caller_id, callee_id, caller_ids, is_group,
    room_id, room_name, caller_device_id, protocol_version,
    call_type, status, encrypted_call_key
  ) values (
    p_call_id, p_conversation_id, v_uid, v_first_invitee, v_invitees,
    cardinality(v_invitees) > 1,
    p_call_id, v_room_name, p_caller_device_id, 5,
    p_call_type, 'ringing', null
  );

  insert into public.aegis_call_invitations (
    call_id, recipient_user_id, recipient_device_id, encrypted_call_key
  )
  select
    p_call_id,
    (entry->>'recipient_user_id')::uuid,
    trim(entry->>'recipient_device_id'),
    entry->>'encrypted_call_key'
  from jsonb_array_elements(p_invitations) entry;

  return jsonb_build_object(
    'ok', true,
    'code', 'CALL_CREATED',
    'call_id', p_call_id,
    'room_name', v_room_name,
    'invitation_count', v_expected_count
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'CALL_ALREADY_EXISTS');
  when others then
    raise;
end;
$$;

revoke all on function public.aegis_call_create(uuid,uuid,text,text,uuid[],jsonb) from public, anon;
grant execute on function public.aegis_call_create(uuid,uuid,text,text,uuid[],jsonb) to authenticated;

create or replace function public.aegis_call_get_invitation(
  p_call_id uuid,
  p_device_id text
)
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select jsonb_build_object(
      'ok', true,
      'call_id', call.id,
      'conversation_id', call.conversation_id,
      'caller_id', call.caller_id,
      'call_type', call.call_type,
      'is_group', call.is_group,
      'room_name', call.room_name,
      'encrypted_call_key', invitation.encrypted_call_key,
      'invitation_status', invitation.status
    )
    from public.aegis_call_invitations invitation
    join public.active_calls call on call.id = invitation.call_id
    where invitation.call_id = p_call_id
      and invitation.recipient_user_id = auth.uid()
      and invitation.recipient_device_id = trim(p_device_id)
      and invitation.status in ('pending', 'accepted')
      and call.status in ('ringing', 'answered', 'accepted')
      and call.protocol_version = 5
  ), jsonb_build_object('ok', false, 'code', 'CALL_INVITATION_NOT_FOUND'));
$$;

revoke all on function public.aegis_call_get_invitation(uuid,text) from public, anon;
grant execute on function public.aegis_call_get_invitation(uuid,text) to authenticated;

create or replace function public.aegis_call_latest_for_device(p_device_id text)
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'ok', true,
    'call', coalesce((
      select jsonb_build_object(
        'id', call.id,
        'conversation_id', call.conversation_id,
        'caller_id', call.caller_id,
        'callee_id', invitation.recipient_user_id,
        'call_type', call.call_type,
        'status', call.status,
        'is_group', call.is_group,
        'room_name', call.room_name,
        'created_at', call.created_at
      )
      from public.aegis_call_invitations invitation
      join public.active_calls call on call.id = invitation.call_id
      where invitation.recipient_user_id = auth.uid()
        and invitation.recipient_device_id = trim(p_device_id)
        and invitation.status = 'pending'
        and call.status = 'ringing'
        and call.protocol_version = 5
        and call.created_at > now() - interval '45 seconds'
      order by call.created_at desc
      limit 1
    ), 'null'::jsonb)
  );
$$;

revoke all on function public.aegis_call_latest_for_device(text) from public, anon;
grant execute on function public.aegis_call_latest_for_device(text) to authenticated;

create or replace function public.aegis_call_update_status(
  p_call_id uuid,
  p_device_id text,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_call public.active_calls%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if p_status not in ('accepted', 'declined', 'ended', 'cancelled') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CALL_STATUS');
  end if;

  select * into v_call from public.active_calls where id = p_call_id for update;
  if not found or v_call.protocol_version <> 5 then
    return jsonb_build_object('ok', false, 'code', 'CALL_NOT_FOUND');
  end if;

  if v_call.caller_id = v_uid then
    if p_device_id is distinct from v_call.caller_device_id then
      return jsonb_build_object('ok', false, 'code', 'CALLER_DEVICE_MISMATCH');
    end if;
    if p_status not in ('ended', 'cancelled') then
      return jsonb_build_object('ok', false, 'code', 'CALLER_STATUS_NOT_ALLOWED');
    end if;
    update public.active_calls
    set status = p_status,
        ended_at = coalesce(ended_at, now())
    where id = p_call_id;
    return jsonb_build_object('ok', true, 'code', 'CALL_CLOSED');
  end if;

  update public.aegis_call_invitations
  set status = p_status,
      responded_at = now()
  where call_id = p_call_id
    and recipient_user_id = v_uid
    and recipient_device_id = trim(p_device_id)
    and status = 'pending';

  if not found then
    return jsonb_build_object('ok', false, 'code', 'CALL_INVITATION_NOT_PENDING');
  end if;

  if p_status = 'accepted' then
    update public.active_calls
    set status = 'answered',
        answered_at = coalesce(answered_at, now())
    where id = p_call_id and status = 'ringing';
  elsif not exists (
    select 1 from public.aegis_call_invitations
    where call_id = p_call_id and status in ('pending', 'accepted')
  ) then
    update public.active_calls
    set status = 'declined',
        ended_at = coalesce(ended_at, now())
    where id = p_call_id;
  end if;

  return jsonb_build_object('ok', true, 'code', 'CALL_INVITATION_UPDATED');
end;
$$;

revoke all on function public.aegis_call_update_status(uuid,text,text) from public, anon;
grant execute on function public.aegis_call_update_status(uuid,text,text) to authenticated;

commit;
