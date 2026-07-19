-- Aegis v1 development cutover.
--
-- There is intentionally no compatibility reader. The application is not in
-- production and retaining an ambiguous legacy wire format would create more
-- recovery paths than useful guarantees. Message loss is accepted for this
-- cutover, so every surviving peer message has exactly one contract:
--   * one AES-256-GCM ciphertext in messages.body;
--   * one Double-Ratchet key capsule for each authenticated device;
--   * one stable UUID binding the parent, capsules, outbox and receipts.

begin;

truncate table public.messages cascade;
-- Old server-verifiable PIN hashes are deliberately discarded. New rows are
-- opaque email-recovery tickets and contain no material derived from the PIN.
truncate table public.user_chat_pins;

alter table public.messages
  drop constraint if exists messages_sesame_lite_body_check;

drop function if exists public.is_supported_sesame_lite_message(text, text);

create or replace function public.is_supported_aegis_message(
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

  return coalesce(
    v_body->>'protocol' = 'forsure-aegis-message'
    and v_body->>'version' = '1'
    and v_body->>'encryptionMode' = 'multi_device'
    and v_body->>'algorithm' = 'AES-256-GCM'
    and v_body->>'keyTransport' = 'device_ratchet'
    and length(v_body->>'messageId') >= 36
    and length(v_body->>'conversationId') >= 36
    and length(v_body->>'senderId') >= 36
    and length(v_body->>'iv') >= 16
    and length(v_body->>'ciphertext') >= 20
    and length(v_body->>'digest') >= 40,
    false
  );
end;
$$;

alter table public.messages
  add constraint messages_aegis_v1_body_check
  check (public.is_supported_aegis_message(body, body_kind));

drop trigger if exists trg_enforce_sesame_lite_message_scope on public.messages;
drop trigger if exists trg_enforce_aegis_message_scope on public.messages;
drop function if exists public.enforce_sesame_lite_message_scope();

create or replace function public.enforce_aegis_message_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_body jsonb;
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
    return new;
  end if;

  if not public.is_supported_aegis_message(new.body, new.body_kind) then
    raise exception 'AEGIS_WIRE_FORMAT_REJECTED' using errcode = '23514';
  end if;

  v_body := new.body::jsonb;
  begin
    if (v_body->>'messageId')::uuid <> new.id
       or (v_body->>'conversationId')::uuid <> new.conversation_id
       or (v_body->>'senderId')::uuid <> new.sender_id then
      raise exception 'AEGIS_STABLE_UUID_BINDING_REJECTED' using errcode = '23514';
    end if;
  exception
    when invalid_text_representation then
      raise exception 'AEGIS_INVALID_UUID' using errcode = '23514';
  end;

  return new;
end;
$$;

create trigger trg_enforce_aegis_message_scope
before insert or update of id, conversation_id, sender_id, body, body_kind
on public.messages
for each row execute function public.enforce_aegis_message_scope();

revoke all on function public.enforce_aegis_message_scope() from public;
revoke all on function public.is_supported_aegis_message(text, text) from public;
grant execute on function public.is_supported_aegis_message(text, text) to authenticated;

alter table public.message_device_copies
  drop constraint if exists message_device_copies_sesame_lite_wire_check;

alter table public.message_device_copies
  add constraint message_device_copies_aegis_v1_wire_check
  check (
    encrypted_body like 'x3dh5.%'
    and (
      encrypted_body not like 'x3dh5.init.%'
      or encrypted_body like 'x3dh5.init.v3.%'
    )
  );

-- Remove the sender-device inference wrapper. Aegis always identifies the
-- sending physical device explicitly, so the server validates the exact signed
-- device route instead of guessing it from client data.
drop function if exists public.send_message_with_device_copies(
  uuid, uuid, text, text, jsonb, jsonb
);

comment on function public.send_message_with_device_copies(
  uuid, uuid, text, text, jsonb, jsonb, text
) is 'Aegis Coordinator: atomically validates the signed device route and commits one stable ciphertext plus every device key capsule.';

comment on table public.e2ee_kt_signing_keys is
  'Public Aegis Coordinator signing identities. Private signing material is deployment-secret only and never stored in this table.';

commit;
