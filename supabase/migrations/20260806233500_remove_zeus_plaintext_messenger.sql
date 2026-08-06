begin;

-- Zeus is an explicit AI surface. It must never be represented as a peer in
-- the end-to-end encrypted messenger, because an AI service cannot hold the
-- user's device keys or participate in the Aegis device protocol.

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
    return null;
  end if;

  return new;
end;
$$;

create or replace function public.reject_zeus_messenger_message()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.sender_id = '00000000-0000-0000-0000-000000000001'::uuid
     or exists (
       select 1
         from public.conversation_participants participant
        where participant.conversation_id = new.conversation_id
          and participant.user_id = '00000000-0000-0000-0000-000000000001'::uuid
     ) then
    -- A legacy caller may create a conversation before trying to insert the
    -- plaintext message. Remove its participants so the empty shell cannot be
    -- exposed in the messenger, then discard the message row.
    delete from public.conversation_participants
     where conversation_id = new.conversation_id;
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists reject_zeus_messenger_participant_trigger
  on public.conversation_participants;
create trigger reject_zeus_messenger_participant_trigger
before insert or update of user_id, conversation_id
on public.conversation_participants
for each row
execute function public.reject_zeus_messenger_participant();

drop trigger if exists reject_zeus_messenger_message_trigger
  on public.messages;
create trigger reject_zeus_messenger_message_trigger
before insert or update of sender_id, conversation_id, body, body_kind
on public.messages
for each row
execute function public.reject_zeus_messenger_message();

-- Remove plaintext history and detach every historical Zeus conversation from
-- the normal messenger. Conversation shells are intentionally left orphaned so
-- this migration does not depend on every optional foreign-key cascade.
create temporary table zeus_messenger_conversations
on commit drop
as
select distinct participant.conversation_id
  from public.conversation_participants participant
 where participant.user_id = '00000000-0000-0000-0000-000000000001'::uuid;

delete from public.messages message
 where message.conversation_id in (
   select conversation_id from zeus_messenger_conversations
 );

delete from public.conversation_participants participant
 where participant.conversation_id in (
   select conversation_id from zeus_messenger_conversations
 );

revoke all on function public.reject_zeus_messenger_participant()
  from public, anon, authenticated;
revoke all on function public.reject_zeus_messenger_message()
  from public, anon, authenticated;

commit;
