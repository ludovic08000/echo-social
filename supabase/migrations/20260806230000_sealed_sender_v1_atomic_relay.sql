-- Lot 1: bind Sealed Sender tokens to a protocol version, sender, recipient,
-- conversation and nonce; consume the token and insert the envelope atomically.

create table if not exists public.sealed_sender_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  nonce text not null unique,
  protocol_version integer,
  sender_user_id uuid references auth.users(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid,
  context_id text,
  issued_at timestamptz,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.sealed_sender_tokens
  add column if not exists protocol_version integer,
  add column if not exists sender_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists conversation_id uuid,
  add column if not exists context_id text,
  add column if not exists issued_at timestamptz,
  add column if not exists consumed_at timestamptz;

create unique index if not exists sealed_sender_tokens_nonce_uidx
  on public.sealed_sender_tokens(nonce);
create index if not exists sealed_sender_tokens_context_idx
  on public.sealed_sender_tokens(recipient_user_id, conversation_id, expires_at);

alter table public.sealed_sender_tokens enable row level security;

drop policy if exists "sealed messages authenticated insert" on public.sealed_sender_messages;
revoke insert on public.sealed_sender_messages from anon, authenticated;
revoke all on public.sealed_sender_tokens from anon, authenticated;

revoke execute on function public.send_sealed_sender_message(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;

create or replace function public.relay_sealed_sender_v1(
  p_token_hash text,
  p_nonce text,
  p_protocol_version integer,
  p_sender_user_id uuid,
  p_recipient_user_id uuid,
  p_conversation_id uuid,
  p_context_id text,
  p_anonymous_sender_tag text,
  p_sealed_payload text,
  p_sealed_header jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_token public.sealed_sender_tokens%rowtype;
  v_message_id uuid;
begin
  if p_protocol_version <> 1 then
    raise exception 'unsupported_protocol_version';
  end if;
  if octet_length(coalesce(p_anonymous_sender_tag, '')) > 512 then
    raise exception 'sender_tag_too_large';
  end if;
  if octet_length(coalesce(p_sealed_payload, '')) > 1500000 then
    raise exception 'sealed_payload_too_large';
  end if;
  if octet_length(coalesce(p_sealed_header, '{}'::jsonb)::text) > 16384 then
    raise exception 'sealed_header_too_large';
  end if;

  select *
    into v_token
    from public.sealed_sender_tokens
   where token_hash = p_token_hash
     and nonce = p_nonce
   for update;

  if not found then
    raise exception 'token_not_found';
  end if;
  if v_token.consumed_at is not null then
    raise exception 'token_consumed';
  end if;
  if v_token.expires_at <= statement_timestamp() then
    raise exception 'token_expired';
  end if;
  if v_token.protocol_version is distinct from p_protocol_version
     or v_token.sender_user_id is distinct from p_sender_user_id
     or v_token.recipient_user_id is distinct from p_recipient_user_id
     or v_token.conversation_id is distinct from p_conversation_id
     or v_token.context_id is distinct from p_context_id then
    raise exception 'token_context_mismatch';
  end if;

  if not exists (
    select 1 from public.conversations c where c.id = p_conversation_id
  ) then
    raise exception 'conversation_not_found';
  end if;
  if not exists (
    select 1 from public.conversation_participants cp
     where cp.conversation_id = p_conversation_id
       and cp.user_id = p_sender_user_id
  ) then
    raise exception 'sender_not_member';
  end if;
  if not exists (
    select 1 from public.conversation_participants cp
     where cp.conversation_id = p_conversation_id
       and cp.user_id = p_recipient_user_id
  ) then
    raise exception 'recipient_not_member';
  end if;

  update public.sealed_sender_tokens
     set consumed_at = statement_timestamp()
   where id = v_token.id
     and consumed_at is null;

  if not found then
    raise exception 'token_consumed';
  end if;

  insert into public.sealed_sender_messages (
    conversation_id,
    recipient_user_id,
    anonymous_sender_tag,
    sealed_payload,
    sealed_header
  ) values (
    p_conversation_id,
    p_recipient_user_id,
    p_anonymous_sender_tag,
    p_sealed_payload,
    coalesce(p_sealed_header, '{}'::jsonb)
  )
  returning id into v_message_id;

  insert into public.sealed_sender_events (
    conversation_id,
    anonymous_sender_tag,
    sender_hint_hash,
    recipient_user_id
  ) values (
    p_conversation_id,
    p_anonymous_sender_tag,
    null,
    p_recipient_user_id
  );

  return v_message_id;
end;
$$;

revoke all on function public.relay_sealed_sender_v1(
  text, text, integer, uuid, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.relay_sealed_sender_v1(
  text, text, integer, uuid, uuid, uuid, text, text, text, jsonb
) to service_role;
