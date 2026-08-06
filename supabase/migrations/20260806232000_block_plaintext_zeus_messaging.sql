begin;

-- Zeus is an AI service, not an E2EE-capable peer. Keeping Zeus inside the
-- regular messenger causes user prompts and AI replies to be persisted in
-- public.messages as plaintext. Irreversibly scrub the existing plaintext
-- while preserving message identifiers referenced by dependent tables.
update public.messages message
   set body = '[zeus_messenger_removed]',
       archive_body = null,
       status = 'blocked',
       body_kind = 'system'
  from public.conversation_participants participant
 where participant.conversation_id = message.conversation_id
   and participant.user_id = '00000000-0000-0000-0000-000000000001'::uuid;

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

revoke all on function public.reject_plaintext_zeus_messenger()
  from public, anon, authenticated;

drop trigger if exists reject_plaintext_zeus_messenger on public.messages;
create trigger reject_plaintext_zeus_messenger
before insert or update of sender_id, conversation_id, body, body_kind
on public.messages
for each row
execute function public.reject_plaintext_zeus_messenger();

-- Prevent future code from recreating a Zeus messenger conversation or from
-- adding participants to a historical Zeus conversation. Existing rows remain
-- as scrubbed legacy records only; no new messenger content is accepted.
create or replace function public.reject_zeus_messenger_participant()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.user_id = '00000000-0000-0000-0000-000000000001'::uuid
     or exists (
       select 1
         from public.conversation_participants participant
        where participant.conversation_id = new.conversation_id
          and participant.user_id = '00000000-0000-0000-0000-000000000001'::uuid
     ) then
    raise exception using
      errcode = '42501',
      message = 'zeus_messenger_participant_forbidden';
  end if;

  return new;
end;
$$;

revoke all on function public.reject_zeus_messenger_participant()
  from public, anon, authenticated;

drop trigger if exists reject_zeus_messenger_participant
  on public.conversation_participants;
create trigger reject_zeus_messenger_participant
before insert or update of conversation_id, user_id
on public.conversation_participants
for each row
execute function public.reject_zeus_messenger_participant();

-- Keep the public welcome-wall greeting, but stop creating a plaintext Zeus
-- direct-message conversation for every new account.
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

  return new;
end;
$$;

commit;
