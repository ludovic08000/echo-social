begin;

create table if not exists public.call_device_key_copies (
  call_id uuid not null references public.active_calls(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_device_id text not null,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  sender_device_id text not null,
  encrypted_body text not null,
  created_at timestamptz not null default now(),
  primary key (call_id, recipient_user_id, recipient_device_id)
);

create index if not exists call_device_key_copies_recipient_idx
  on public.call_device_key_copies(recipient_user_id, recipient_device_id, call_id);

alter table public.call_device_key_copies enable row level security;
revoke all on table public.call_device_key_copies from anon, authenticated;

create or replace function public.reject_raw_group_call_key()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.is_group, false) and new.encrypted_call_key is not null then
    raise exception using
      errcode = '22023',
      message = 'GROUP_CALL_RAW_KEY_FORBIDDEN';
  end if;
  return new;
end;
$$;

drop trigger if exists active_calls_reject_raw_group_call_key on public.active_calls;
create trigger active_calls_reject_raw_group_call_key
before insert or update of encrypted_call_key, is_group on public.active_calls
for each row execute function public.reject_raw_group_call_key();

create or replace function public.create_secure_call_v1(
  p_call_id uuid,
  p_conversation_id uuid,
  p_room_id text,
  p_call_type text,
  p_invitee_ids uuid[],
  p_sender_device_id text,
  p_key_copies jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_invitee_count integer;
  v_expected_count integer;
  v_copy_count integer;
  v_existing public.active_calls%rowtype;
  v_first_invitee uuid;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if p_call_id is null or p_conversation_id is null
     or p_call_type not in ('audio', 'video')
     or length(trim(coalesce(p_room_id, ''))) not between 8 and 128
     or length(trim(coalesce(p_sender_device_id, ''))) < 8
     or jsonb_typeof(p_key_copies) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'CALL_INVALID_ARGUMENT');
  end if;

  select count(distinct invitee), min(invitee)
    into v_invitee_count, v_first_invitee
  from unnest(coalesce(p_invitee_ids, '{}'::uuid[])) invitee
  where invitee is not null and invitee <> v_uid;
  if v_invitee_count not between 1 and 7
     or v_invitee_count <> cardinality(coalesce(p_invitee_ids, '{}'::uuid[])) then
    return jsonb_build_object('ok', false, 'code', 'CALL_INVALID_INVITEE_SET');
  end if;

  if not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id and cp.user_id = v_uid
  ) then
    return jsonb_build_object('ok', false, 'code', 'CALLER_NOT_IN_CONVERSATION');
  end if;
  if exists (
    select 1
    from unnest(p_invitee_ids) invitee
    where not exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = p_conversation_id and cp.user_id = invitee
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVITEE_NOT_IN_CONVERSATION');
  end if;

  if not exists (
    select 1 from public.get_sesame_device_list(v_uid) sender
    where sender.device_id = trim(p_sender_device_id)
  ) then
    return jsonb_build_object('ok', false, 'code', 'CALL_SENDER_DEVICE_NOT_TRUSTED');
  end if;

  select * into v_existing from public.active_calls where id = p_call_id;
  if found then
    if v_existing.caller_id = v_uid
       and v_existing.conversation_id = p_conversation_id
       and v_existing.room_id = trim(p_room_id) then
      return jsonb_build_object(
        'ok', true,
        'code', 'CALL_ALREADY_COMMITTED',
        'id', v_existing.id,
        'room_id', v_existing.room_id,
        'status', v_existing.status
      );
    end if;
    return jsonb_build_object('ok', false, 'code', 'CALL_ID_CONFLICT');
  end if;

  select count(*) into v_expected_count
  from (
    select invitee as user_id, device.device_id
    from unnest(p_invitee_ids) invitee
    cross join lateral public.get_sesame_device_list(invitee) device
  ) expected;
  if v_expected_count < v_invitee_count then
    return jsonb_build_object('ok', false, 'code', 'CALL_RECIPIENT_DEVICE_ROUTE_UNAVAILABLE');
  end if;

  select count(*) into v_copy_count from jsonb_array_elements(p_key_copies);
  if v_copy_count <> v_expected_count then
    return jsonb_build_object('ok', false, 'code', 'CALL_DEVICE_ROUTE_STALE');
  end if;
  if (
    select count(*) from (
      select distinct
        copy->>'recipient_user_id' as user_id,
        copy->>'recipient_device_id' as device_id
      from jsonb_array_elements(p_key_copies) copy
    ) unique_copies
  ) <> v_copy_count then
    return jsonb_build_object('ok', false, 'code', 'CALL_DUPLICATE_DEVICE_COPY');
  end if;

  if exists (
    with expected as (
      select invitee::text as user_id, device.device_id
      from unnest(p_invitee_ids) invitee
      cross join lateral public.get_sesame_device_list(invitee) device
    )
    select 1
    from jsonb_array_elements(p_key_copies) copy
    left join expected
      on expected.user_id = copy->>'recipient_user_id'
     and expected.device_id = copy->>'recipient_device_id'
    where expected.device_id is null
       or copy->>'sender_device_id' <> trim(p_sender_device_id)
       or length(coalesce(copy->>'encrypted_body', '')) not between 32 and 131072
       or not (
         copy->>'encrypted_body' like 'aegis1.ratchet.%'
         or copy->>'encrypted_body' like 'aegis1.init.v1.%'
       )
  ) then
    return jsonb_build_object('ok', false, 'code', 'CALL_DEVICE_COPY_INVALID');
  end if;

  insert into public.active_calls (
    id,
    conversation_id,
    caller_id,
    callee_id,
    caller_ids,
    is_group,
    room_id,
    call_type,
    status,
    encrypted_call_key
  ) values (
    p_call_id,
    p_conversation_id,
    v_uid,
    v_first_invitee,
    p_invitee_ids,
    v_invitee_count > 1,
    trim(p_room_id),
    p_call_type,
    'ringing',
    null
  );

  insert into public.call_device_key_copies (
    call_id,
    recipient_user_id,
    recipient_device_id,
    sender_user_id,
    sender_device_id,
    encrypted_body
  )
  select
    p_call_id,
    (copy->>'recipient_user_id')::uuid,
    copy->>'recipient_device_id',
    v_uid,
    trim(p_sender_device_id),
    copy->>'encrypted_body'
  from jsonb_array_elements(p_key_copies) copy;

  return jsonb_build_object(
    'ok', true,
    'code', 'SECURE_CALL_CREATED',
    'id', p_call_id,
    'room_id', trim(p_room_id),
    'status', 'ringing'
  );
end;
$$;

revoke all on function public.create_secure_call_v1(
  uuid, uuid, text, text, uuid[], text, jsonb
) from public, anon;
grant execute on function public.create_secure_call_v1(
  uuid, uuid, text, text, uuid[], text, jsonb
) to authenticated;

create or replace function public.get_secure_call_device_key_v1(
  p_call_id uuid,
  p_device_id text
)
returns table (
  encrypted_body text,
  sender_user_id uuid,
  sender_device_id text,
  conversation_id uuid,
  caller_id uuid
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    copy.encrypted_body,
    copy.sender_user_id,
    copy.sender_device_id,
    call.conversation_id,
    call.caller_id
  from public.call_device_key_copies copy
  join public.active_calls call on call.id = copy.call_id
  where copy.call_id = p_call_id
    and copy.recipient_user_id = auth.uid()
    and copy.recipient_device_id = trim(p_device_id)
    and call.status in ('ringing', 'accepted', 'answered')
    and exists (
      select 1 from public.get_sesame_device_list(auth.uid()) device
      where device.device_id = trim(p_device_id)
    )
  limit 1;
$$;

revoke all on function public.get_secure_call_device_key_v1(uuid, text) from public, anon;
grant execute on function public.get_secure_call_device_key_v1(uuid, text) to authenticated;

create or replace function public.get_secure_call_state_v1(p_call_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'ok', true,
    'id', call.id,
    'room_id', call.room_id,
    'status', call.status
  )
  from public.active_calls call
  where call.id = p_call_id
    and (
      call.caller_id = auth.uid()
      or call.callee_id = auth.uid()
      or auth.uid() = any(coalesce(call.caller_ids, '{}'::uuid[]))
    )
  limit 1;
$$;

revoke all on function public.get_secure_call_state_v1(uuid) from public, anon;
grant execute on function public.get_secure_call_state_v1(uuid) to authenticated;

commit;
