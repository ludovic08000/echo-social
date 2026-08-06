begin;

-- Zeus is an explicit AI surface. It must never be represented as a peer in
-- the end-to-end encrypted messenger, because an AI service cannot hold the
-- user's device keys or participate in the Aegis device protocol.

-- Persist the blocked conversation id before suppressing a Zeus participant.
-- Without this marker, a legacy caller could insert the human participant,
-- have the Zeus participant rejected, then insert the human's prompt into an
-- apparently ordinary conversation.
create table if not exists public.zeus_messenger_blocked_conversations (
  conversation_id uuid primary key,
  blocked_at timestamptz not null default clock_timestamp()
);

alter table public.zeus_messenger_blocked_conversations enable row level security;
revoke all on table public.zeus_messenger_blocked_conversations
  from public, anon, authenticated;

-- Seed the durable marker before historical Zeus participant rows are removed.
insert into public.zeus_messenger_blocked_conversations (conversation_id)
select distinct participant.conversation_id
  from public.conversation_participants participant
 where participant.user_id = '00000000-0000-0000-0000-000000000001'::uuid
on conflict (conversation_id) do update
set blocked_at = excluded.blocked_at;

-- The previous migration already installed a fail-closed message trigger. Drop
-- it temporarily so historical plaintext can be scrubbed without deleting rows
-- referenced by reactions, receipts or other dependent tables.
drop trigger if exists reject_plaintext_zeus_messenger
  on public.messages;
drop trigger if exists reject_zeus_messenger_message_trigger
  on public.messages;

update public.message_archives archive
   set archive_body = '[zeus_messenger_removed]'
 where archive.message_id in (
   select message.id
     from public.messages message
    where message.conversation_id in (
      select blocked.conversation_id
        from public.zeus_messenger_blocked_conversations blocked
    )
 );

update public.messages message
   set body = '[zeus_messenger_removed]',
       archive_body = null,
       status = 'blocked',
       body_kind = 'system'
 where message.conversation_id in (
   select blocked.conversation_id
     from public.zeus_messenger_blocked_conversations blocked
 );

-- Detach historical Zeus conversations from the normal messenger. Conversation
-- shells remain orphaned so this migration does not depend on optional cascades.
delete from public.conversation_participants participant
 where participant.conversation_id in (
   select blocked.conversation_id
     from public.zeus_messenger_blocked_conversations blocked
 );

create or replace function public.zeus_welcome_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_zeus_id constant uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  v_welcome_wall constant text := '👋 Bienvenue sur Forsure ! Je suis Zeus, ton compagnon IA. N''hésite pas à me parler si tu as besoin d''aide ou simplement envie de discuter. Amuse-toi bien ! ⚡';
begin
  if exists (
    select 1
      from auth.users account
     where account.id = new.user_id
       and account.is_anonymous = true
  ) then
    return new;
  end if;

  insert into public.anonymous_wall_messages (
    author_id,
    target_user_id,
    message,
    is_approved
  ) values (
    v_zeus_id,
    new.user_id,
    v_welcome_wall,
    true
  );

  -- No conversation or public.messages row is created. Zeus remains available
  -- only through the dedicated AI companion surface.
  return new;
end;
$$;

create or replace function public.reject_zeus_messenger_participant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.user_id = '00000000-0000-0000-0000-000000000001'::uuid then
    insert into public.zeus_messenger_blocked_conversations (conversation_id)
    values (new.conversation_id)
    on conflict (conversation_id) do update
    set blocked_at = excluded.blocked_at;
    return null;
  end if;

  if exists (
    select 1
      from public.zeus_messenger_blocked_conversations blocked
     where blocked.conversation_id = new.conversation_id
  ) or exists (
    select 1
      from public.conversation_participants participant
     where participant.conversation_id = new.conversation_id
       and participant.user_id = '00000000-0000-0000-0000-000000000001'::uuid
  ) then
    return null;
  end if;

  return new;
end;
$$;

create or replace function public.reject_plaintext_zeus_messenger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.sender_id = '00000000-0000-0000-0000-000000000001'::uuid
     or exists (
       select 1
         from public.zeus_messenger_blocked_conversations blocked
        where blocked.conversation_id = new.conversation_id
     )
     or exists (
       select 1
         from public.conversation_participants participant
        where participant.conversation_id = new.conversation_id
          and participant.user_id = '00000000-0000-0000-0000-000000000001'::uuid
     ) then
    raise exception using
      errcode = '42501',
      message = 'zeus_messenger_e2ee_required';
  end if;

  return new;
end;
$$;

-- Remove every historical or intermediate trigger name before installing the
-- canonical names asserted by the SQL security suite.
drop trigger if exists reject_zeus_messenger_participant_trigger
  on public.conversation_participants;
drop trigger if exists reject_zeus_messenger_participant
  on public.conversation_participants;
create trigger reject_zeus_messenger_participant
before insert or update of user_id, conversation_id
on public.conversation_participants
for each row
execute function public.reject_zeus_messenger_participant();

drop trigger if exists reject_plaintext_zeus_messenger
  on public.messages;
create trigger reject_plaintext_zeus_messenger
before insert or update of sender_id, conversation_id, body, body_kind
on public.messages
for each row
execute function public.reject_plaintext_zeus_messenger();

drop function if exists public.reject_zeus_messenger_message();

revoke all on function public.reject_plaintext_zeus_messenger()
  from public, anon, authenticated;
revoke all on function public.reject_zeus_messenger_participant()
  from public, anon, authenticated;

commit;
