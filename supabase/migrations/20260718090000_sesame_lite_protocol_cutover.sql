-- Development cutover: there is deliberately no compatibility reader or data
-- migration. The project is not in production and old messages may be lost.
truncate table public.messages cascade;

drop trigger if exists trg_auto_enable_sender_keys_on_participants
  on public.conversation_participants;
drop function if exists public.maybe_enable_sender_keys_for_group();
drop table if exists public.sender_key_distribution cascade;
drop table if exists public.sender_key_state cascade;
alter table public.conversations drop column if exists enable_sender_keys;
drop table if exists public.e2ee_session_sync cascade;

drop function if exists public.send_message_with_device_copies(
  uuid,
  uuid,
  text,
  text,
  jsonb,
  jsonb
);

create or replace function public.is_supported_sesame_lite_message(
  p_body text,
  p_body_kind text
) returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_body jsonb;
begin
  if p_body_kind = 'system' then
    return true;
  end if;

  if p_body_kind <> 'multi_device' then
    return false;
  end if;

  begin
    v_body := p_body::jsonb;
  exception when others then
    return false;
  end;

  return coalesce(v_body->>'protocol' = 'forsure-sesame-lite'
    and v_body->>'version' = '1'
    and v_body->>'encryptionMode' = 'multi_device'
    and v_body->>'ct' = 'device_copies', false);
end;
$$;

alter table public.messages
  drop constraint if exists messages_sesame_lite_body_check;

alter table public.messages
  add constraint messages_sesame_lite_body_check
  check (public.is_supported_sesame_lite_message(body, body_kind));

-- SECURITY DEFINER message RPCs bypass RLS, so enforce the Zeus plaintext
-- exception independently at the table boundary. A conversation containing a
-- third participant is always a peer conversation and must remain encrypted.
create or replace function public.enforce_sesame_lite_message_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.body_kind = 'system' then
    if not exists (
      select 1
      from public.conversation_participants sender_cp
      where sender_cp.conversation_id = new.conversation_id
        and sender_cp.user_id = new.sender_id
    ) or not exists (
      select 1
      from public.conversation_participants zeus_cp
      where zeus_cp.conversation_id = new.conversation_id
        and zeus_cp.user_id = '00000000-0000-0000-0000-000000000001'::uuid
    ) or exists (
      select 1
      from public.conversation_participants other_cp
      where other_cp.conversation_id = new.conversation_id
        and other_cp.user_id not in (
          new.sender_id,
          '00000000-0000-0000-0000-000000000001'::uuid
        )
    ) then
      raise exception 'E2EE_SYSTEM_MESSAGE_SCOPE_REJECTED'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_sesame_lite_message_scope on public.messages;
create trigger trg_enforce_sesame_lite_message_scope
before insert or update of conversation_id, sender_id, body_kind
on public.messages
for each row execute function public.enforce_sesame_lite_message_scope();

revoke all on function public.enforce_sesame_lite_message_scope() from public;

alter table public.message_device_copies
  drop constraint if exists message_device_copies_sesame_lite_wire_check;

alter table public.message_device_copies
  add constraint message_device_copies_sesame_lite_wire_check
  check (
    encrypted_body like 'x3dh5.%'
    and (
      encrypted_body not like 'x3dh5.init.%'
      or encrypted_body like 'x3dh5.init.v3.%'
    )
  );

revoke all on function public.is_supported_sesame_lite_message(text, text) from public;
grant execute on function public.is_supported_sesame_lite_message(text, text) to authenticated;

-- The authoritative RPC validates membership, the signed device route, exact
-- coverage and every copy before inserting parent + copies in one transaction.
alter function public.send_message_with_device_copies(
  uuid, uuid, text, text, jsonb, jsonb, text
) security definer;

-- Prevent direct client inserts from bypassing the atomic RPC. Plaintext is
-- accepted directly only for the explicit Zeus/system conversation.
drop policy if exists "Users can send messages in their conversations"
  on public.messages;
create policy "Users can send Zeus system messages"
on public.messages for insert
with check (
  auth.uid() = sender_id
  and body_kind = 'system'
  and exists (
    select 1
    from public.conversation_participants self_cp
    where self_cp.conversation_id = messages.conversation_id
      and self_cp.user_id = auth.uid()
  )
  and exists (
    select 1
    from public.conversation_participants zeus_cp
    where zeus_cp.conversation_id = messages.conversation_id
      and zeus_cp.user_id = '00000000-0000-0000-0000-000000000001'::uuid
  )
  and not exists (
    select 1
    from public.conversation_participants other_cp
    where other_cp.conversation_id = messages.conversation_id
      and other_cp.user_id not in (
        auth.uid(),
        '00000000-0000-0000-0000-000000000001'::uuid
      )
  )
);
