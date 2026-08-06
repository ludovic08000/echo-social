begin;

-- A legacy caller can insert the human participant before attempting to add
-- Zeus. When the Zeus row is rejected, remove any participant already attached
-- to that conversation so the blocked empty shell cannot remain visible.
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

    delete from public.conversation_participants participant
     where participant.conversation_id = new.conversation_id;

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

revoke all on function public.reject_zeus_messenger_participant()
  from public, anon, authenticated;

commit;
