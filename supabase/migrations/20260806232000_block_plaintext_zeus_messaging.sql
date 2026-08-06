begin;

-- Zeus is an AI service, not an E2EE-capable peer. Keeping Zeus inside the
-- regular messenger causes user prompts and AI replies to be persisted in
-- public.messages as plaintext. Remove the existing plaintext corpus and
-- fail closed until Zeus has a dedicated, explicitly non-E2EE surface.
delete from public.messages m
using public.conversation_participants cp
where cp.conversation_id = m.conversation_id
  and cp.user_id = '00000000-0000-0000-0000-000000000001'::uuid;

create or replace function public.reject_plaintext_zeus_messenger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if exists (
    select 1
      from public.conversation_participants cp
     where cp.conversation_id = new.conversation_id
       and cp.user_id = '00000000-0000-0000-0000-000000000001'::uuid
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
before insert or update of conversation_id, body, body_kind
on public.messages
for each row
execute function public.reject_plaintext_zeus_messenger();

-- Prevent future code from recreating a Zeus messenger conversation or from
-- adding participants to a historical Zeus conversation. Existing rows remain
-- readable only as empty legacy shells; the messages trigger above blocks all
-- new content until the UI is moved to a dedicated non-E2EE surface.
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
         from public.conversation_participants cp
        where cp.conversation_id = new.conversation_id
          and cp.user_id = '00000000-0000-0000-0000-000000000001'::uuid
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
  zeus_id uuid := '00000000-0000-0000-0000-000000000001';
  welcome_wall text := '👋 Bienvenue sur Forsure ! Je suis Zeus, ton compagnon IA. N''hésite pas à me parler si tu as besoin d''aide ou simplement envie de discuter. Amuse-toi bien ! ⚡';
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
    zeus_id,
    new.user_id,
    welcome_wall,
    true
  );

  return new;
end;
$$;

commit;
