-- Aegis view-once delivery and destructive consumption.
--
-- The normal Aegis send RPC commits the immutable parent and complete device
-- fan-out first. A deferred trigger then moves the encrypted parent and the
-- recipient-specific capsules into a sealed per-user payload, removes every
-- normal device copy and redacts the visible parent row. The payload is exposed
-- only through the claim/commit RPCs below.

begin;

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.aegis_view_once_payloads (
  message_id uuid not null references public.messages(id) on delete cascade,
  conversation_id uuid not null,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  parent_body text not null,
  image_url text not null,
  device_copies jsonb not null check (jsonb_typeof(device_copies) = 'array'),
  claim_token uuid,
  claimed_device_id text,
  claim_expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (message_id, recipient_user_id)
);

create table if not exists public.aegis_view_once_consumptions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  claim_token uuid not null,
  consumed_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.aegis_view_once_payloads enable row level security;
alter table public.aegis_view_once_consumptions enable row level security;

revoke all on table public.aegis_view_once_payloads from public, anon, authenticated;
revoke all on table public.aegis_view_once_consumptions from public, anon, authenticated;
grant select on table public.aegis_view_once_consumptions to authenticated;

drop policy if exists aegis_view_once_consumption_select_own on public.aegis_view_once_consumptions;
create policy aegis_view_once_consumption_select_own
  on public.aegis_view_once_consumptions
  for select
  to authenticated
  using (user_id = auth.uid());

create or replace function public.stage_aegis_view_once_payload()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_payload_count integer := 0;
begin
  if new.view_once is not true then
    return new;
  end if;
  if new.body_kind is distinct from 'multi_device'
     or new.aegis_request_digest is null
     or nullif(new.image_url, '') is null
     or nullif(new.document_url, '') is not null then
    raise exception 'AEGIS_VIEW_ONCE_MEDIA_REQUIRED' using errcode = '23514';
  end if;

  insert into public.aegis_view_once_payloads (
    message_id,
    conversation_id,
    sender_user_id,
    recipient_user_id,
    parent_body,
    image_url,
    device_copies
  )
  select
    new.id,
    new.conversation_id,
    new.sender_id,
    copy.recipient_user_id,
    new.body,
    new.image_url,
    jsonb_agg(
      jsonb_build_object(
        'recipient_device_id', copy.recipient_device_id,
        'sender_device_id', copy.sender_device_id,
        'encrypted_body', copy.encrypted_body
      )
      order by copy.recipient_device_id, copy.sender_device_id
    )
  from public.message_device_copies copy
  where copy.message_id = new.id
    and copy.recipient_user_id <> new.sender_id
  group by copy.recipient_user_id;

  get diagnostics v_payload_count = row_count;
  if v_payload_count = 0 then
    raise exception 'AEGIS_VIEW_ONCE_RECIPIENT_PAYLOAD_MISSING' using errcode = '23514';
  end if;

  delete from public.message_device_copies where message_id = new.id;
  delete from public.message_archives where message_id = new.id;

  update public.messages
     set body = '🔒 Vue unique',
         body_kind = 'view_once',
         image_url = null,
         document_url = null,
         document_name = null,
         document_mime = null,
         document_size_bytes = null,
         archive_body = null
   where id = new.id;

  return new;
end;
$$;

drop trigger if exists aegis_stage_view_once_payload on public.messages;
create constraint trigger aegis_stage_view_once_payload
  after insert on public.messages
  deferrable initially deferred
  for each row
  when (new.view_once is true)
  execute function public.stage_aegis_view_once_payload();

create or replace function public.begin_aegis_view_once_consume(
  p_message_id uuid,
  p_device_id text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_message record;
  v_payload record;
  v_copy jsonb;
  v_token uuid;
  v_expires timestamptz;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_message_id is null or length(trim(coalesce(p_device_id, ''))) < 8 then
    raise exception 'AEGIS_VIEW_ONCE_DEVICE_REQUIRED' using errcode = '22023';
  end if;

  select id, conversation_id, sender_id, view_once
    into v_message
    from public.messages
   where id = p_message_id;

  if not found or v_message.view_once is not true then
    return jsonb_build_object('state', 'not_found');
  end if;
  if v_message.sender_id = v_uid then
    return jsonb_build_object('state', 'sender');
  end if;
  if not exists (
    select 1 from public.conversation_participants participant
     where participant.conversation_id = v_message.conversation_id
       and participant.user_id = v_uid
  ) then
    raise exception 'AEGIS_VIEW_ONCE_NOT_PARTICIPANT' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.get_sesame_device_list(v_uid) device
     where device.device_id = trim(p_device_id)
       and device.is_routable = true
  ) then
    raise exception 'AEGIS_VIEW_ONCE_DEVICE_NOT_AUTHORIZED' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.aegis_view_once_consumptions consumed
     where consumed.message_id = p_message_id
       and consumed.user_id = v_uid
  ) then
    return jsonb_build_object('state', 'consumed');
  end if;

  select *
    into v_payload
    from public.aegis_view_once_payloads payload
   where payload.message_id = p_message_id
     and payload.recipient_user_id = v_uid
   for update;

  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;

  select item
    into v_copy
    from jsonb_array_elements(v_payload.device_copies) item
   where item->>'recipient_device_id' = trim(p_device_id)
   limit 1;

  if v_copy is null then
    raise exception 'AEGIS_VIEW_ONCE_DEVICE_COPY_MISSING' using errcode = '42501';
  end if;

  if v_payload.claim_token is not null
     and v_payload.claim_expires_at > now()
     and v_payload.claimed_device_id is distinct from trim(p_device_id) then
    return jsonb_build_object('state', 'claimed_elsewhere');
  end if;

  if v_payload.claim_token is not null
     and v_payload.claim_expires_at > now()
     and v_payload.claimed_device_id = trim(p_device_id) then
    v_token := v_payload.claim_token;
    v_expires := v_payload.claim_expires_at;
  else
    v_token := gen_random_uuid();
    v_expires := now() + interval '5 minutes';
    update public.aegis_view_once_payloads
       set claim_token = v_token,
           claimed_device_id = trim(p_device_id),
           claim_expires_at = v_expires
     where message_id = p_message_id
       and recipient_user_id = v_uid;
  end if;

  return jsonb_build_object(
    'state', 'claimed',
    'protocol', 'aegis-view-once-v1',
    'message_id', p_message_id,
    'conversation_id', v_payload.conversation_id,
    'sender_user_id', v_payload.sender_user_id,
    'sender_device_id', v_copy->>'sender_device_id',
    'claim_token', v_token,
    'claim_expires_at', v_expires,
    'parent_body', v_payload.parent_body,
    'image_url', v_payload.image_url,
    'encrypted_body', v_copy->>'encrypted_body'
  );
end;
$$;

create or replace function public.commit_aegis_view_once_consume(
  p_message_id uuid,
  p_device_id text,
  p_claim_token uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_existing_token uuid;
  v_payload record;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_message_id is null or p_claim_token is null or length(trim(coalesce(p_device_id, ''))) < 8 then
    raise exception 'AEGIS_VIEW_ONCE_COMMIT_INVALID' using errcode = '22023';
  end if;

  select consumed.claim_token
    into v_existing_token
    from public.aegis_view_once_consumptions consumed
   where consumed.message_id = p_message_id
     and consumed.user_id = v_uid;

  if found then
    if v_existing_token = p_claim_token then
      return jsonb_build_object(
        'state', 'committed',
        'protocol', 'aegis-view-once-v1',
        'message_id', p_message_id,
        'claim_token', p_claim_token,
        'existing', true
      );
    end if;
    raise exception 'AEGIS_VIEW_ONCE_ALREADY_CONSUMED' using errcode = '23505';
  end if;

  select *
    into v_payload
    from public.aegis_view_once_payloads payload
   where payload.message_id = p_message_id
     and payload.recipient_user_id = v_uid
   for update;

  if not found
     or v_payload.claim_token is distinct from p_claim_token
     or v_payload.claimed_device_id is distinct from trim(p_device_id)
     or v_payload.claim_expires_at <= now() then
    raise exception 'AEGIS_VIEW_ONCE_CLAIM_INVALID' using errcode = '40001';
  end if;

  insert into public.aegis_view_once_consumptions (
    message_id, user_id, device_id, claim_token
  ) values (
    p_message_id, v_uid, trim(p_device_id), p_claim_token
  );

  delete from public.aegis_view_once_payloads
   where message_id = p_message_id
     and recipient_user_id = v_uid;

  return jsonb_build_object(
    'state', 'committed',
    'protocol', 'aegis-view-once-v1',
    'message_id', p_message_id,
    'claim_token', p_claim_token,
    'existing', false
  );
end;
$$;

create or replace function public.release_aegis_view_once_claim(
  p_message_id uuid,
  p_device_id text,
  p_claim_token uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  update public.aegis_view_once_payloads
     set claim_token = null,
         claimed_device_id = null,
         claim_expires_at = null
   where message_id = p_message_id
     and recipient_user_id = v_uid
     and claim_token = p_claim_token
     and claimed_device_id = trim(p_device_id);
  return found;
end;
$$;

create or replace function public.delete_aegis_message_for_me(
  p_message_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_conversation_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select message.conversation_id
    into v_conversation_id
    from public.messages message
   where message.id = p_message_id;
  if not found or not exists (
    select 1 from public.conversation_participants participant
     where participant.conversation_id = v_conversation_id
       and participant.user_id = v_uid
  ) then
    raise exception 'MESSAGE_DELETE_NOT_ALLOWED' using errcode = '42501';
  end if;

  insert into public.message_deletions (message_id, user_id)
  values (p_message_id, v_uid)
  on conflict (message_id, user_id) do nothing;

  delete from public.aegis_view_once_payloads
   where message_id = p_message_id and recipient_user_id = v_uid;
  delete from public.aegis_view_once_consumptions
   where message_id = p_message_id and user_id = v_uid;
  delete from public.message_archives
   where message_id = p_message_id and user_id = v_uid;
  return true;
end;
$$;

create or replace function public.delete_aegis_message_for_everyone(
  p_message_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_sender uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select message.sender_id
    into v_sender
    from public.messages message
   where message.id = p_message_id
   for update;
  if not found or v_sender is distinct from v_uid then
    raise exception 'MESSAGE_DELETE_NOT_ALLOWED' using errcode = '42501';
  end if;
  delete from public.message_archives where message_id = p_message_id;
  delete from public.messages where id = p_message_id;
  return true;
end;
$$;

revoke all on function public.begin_aegis_view_once_consume(uuid, text) from public, anon;
revoke all on function public.commit_aegis_view_once_consume(uuid, text, uuid) from public, anon;
revoke all on function public.release_aegis_view_once_claim(uuid, text, uuid) from public, anon;
revoke all on function public.delete_aegis_message_for_me(uuid) from public, anon;
revoke all on function public.delete_aegis_message_for_everyone(uuid) from public, anon;

grant execute on function public.begin_aegis_view_once_consume(uuid, text) to authenticated;
grant execute on function public.commit_aegis_view_once_consume(uuid, text, uuid) to authenticated;
grant execute on function public.release_aegis_view_once_claim(uuid, text, uuid) to authenticated;
grant execute on function public.delete_aegis_message_for_me(uuid) to authenticated;
grant execute on function public.delete_aegis_message_for_everyone(uuid) to authenticated;

comment on table public.aegis_view_once_payloads is
  'Sealed per-recipient view-once parent and device capsules; no direct client access.';
comment on function public.commit_aegis_view_once_consume(uuid, text, uuid) is
  'Authoritatively records one consumption and cryptographically erases the recipient payload.';

do $$
begin
  alter publication supabase_realtime add table public.aegis_view_once_consumptions;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

notify pgrst, 'reload schema';
commit;
