begin;

-- Le message Aegis demeure l'autorité de livraison. Cette file ne transporte
-- qu'un réveil opaque et ne doit jamais stocker l'identité de l'expéditeur.
create table if not exists public.sealed_sender_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  anonymous_sender_tag text not null,
  sealed_payload text not null,
  sealed_header jsonb not null default '{}'::jsonb,
  context_id text,
  delivery_state text not null default 'queued',
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  read_at timestamptz
);

alter table public.sealed_sender_messages
  add column if not exists context_id text;

create index if not exists idx_sealed_sender_messages_recipient
  on public.sealed_sender_messages(recipient_user_id, created_at desc);
create unique index if not exists sealed_sender_messages_recipient_context_uidx
  on public.sealed_sender_messages(recipient_user_id, context_id)
  where context_id is not null;

alter table public.sealed_sender_messages enable row level security;
revoke all on public.sealed_sender_messages from public, anon, authenticated;
grant select on public.sealed_sender_messages to authenticated;
grant all on public.sealed_sender_messages to service_role;
drop policy if exists "sealed messages authenticated insert" on public.sealed_sender_messages;
drop policy if exists "sealed messages recipient update state" on public.sealed_sender_messages;
drop policy if exists "ssm_recipient_read" on public.sealed_sender_messages;
drop policy if exists "ssm_recipient_update" on public.sealed_sender_messages;
drop policy if exists "sealed messages recipient read" on public.sealed_sender_messages;
create policy "sealed messages recipient read"
  on public.sealed_sender_messages
  for select
  to authenticated
  using ((select auth.uid()) = recipient_user_id);

create table if not exists public.sealed_sender_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid,
  anonymous_sender_tag text not null,
  sender_hint_hash text,
  recipient_user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.sealed_sender_events enable row level security;
revoke all on public.sealed_sender_events from public, anon, authenticated;
grant all on public.sealed_sender_events to service_role;
drop policy if exists "sealed sender recipient read" on public.sealed_sender_events;
drop policy if exists "sealed sender authenticated insert" on public.sealed_sender_events;
drop policy if exists "sse_recipient_read" on public.sealed_sender_events;
drop policy if exists "sse_auth_insert" on public.sealed_sender_events;

create table if not exists public.sealed_sender_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  nonce text not null unique,
  protocol_version integer not null,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  context_id text,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.sealed_sender_tokens
  add column if not exists protocol_version integer,
  add column if not exists recipient_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists conversation_id uuid,
  add column if not exists context_id text,
  add column if not exists issued_at timestamptz,
  add column if not exists consumed_at timestamptz;

-- Une ancienne migration possédait cette colonne. Elle reste nullable pour ne
-- pas casser une base déjà migrée, mais aucune nouvelle valeur n'y est écrite.
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'sealed_sender_tokens'
       and column_name = 'sender_user_id'
  ) then
    execute 'update public.sealed_sender_tokens set sender_user_id = null where sender_user_id is not null';
  end if;
end;
$$;

create unique index if not exists sealed_sender_tokens_nonce_uidx
  on public.sealed_sender_tokens(nonce);
create index if not exists sealed_sender_tokens_context_idx
  on public.sealed_sender_tokens(recipient_user_id, conversation_id, expires_at);
create index if not exists sealed_sender_tokens_expiry_idx
  on public.sealed_sender_tokens(expires_at);

alter table public.sealed_sender_tokens enable row level security;
revoke all on public.sealed_sender_tokens from public, anon, authenticated;
grant all on public.sealed_sender_tokens to service_role;

drop function if exists public.send_sealed_sender_message(uuid, uuid, text, text, jsonb);
drop function if exists public.mark_sealed_sender_delivered(uuid);
drop function if exists public.relay_sealed_sender_v1(
  text, text, integer, uuid, uuid, uuid, text, text, text, jsonb
);

create or replace function public.relay_sealed_sender(
  p_token_hash text,
  p_nonce text,
  p_protocol_version integer,
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
  if p_context_id is null
     or p_context_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'invalid_context';
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
     or v_token.recipient_user_id is distinct from p_recipient_user_id
     or v_token.conversation_id is distinct from p_conversation_id
     or v_token.context_id is distinct from p_context_id then
    raise exception 'token_context_mismatch';
  end if;

  if not exists (
    select 1
      from public.conversations c
     where c.id = p_conversation_id
  ) then
    raise exception 'conversation_not_found';
  end if;
  if not exists (
    select 1
      from public.conversation_participants cp
     where cp.conversation_id = p_conversation_id
       and cp.user_id = p_recipient_user_id
  ) then
    raise exception 'recipient_not_member';
  end if;
  if not exists (
    select 1
      from public.messages message
     where message.id = p_context_id::uuid
       and message.conversation_id = p_conversation_id
  ) then
    raise exception 'message_not_committed';
  end if;
  if not exists (
    select 1
      from public.aegis_device_inbox inbox
     where inbox.message_id = p_context_id::uuid
       and inbox.recipient_user_id = p_recipient_user_id
  ) then
    raise exception 'recipient_not_targeted';
  end if;

  -- La suppression et l'insertion partagent la transaction : un jeton ne peut
  -- produire qu'un seul réveil, même sous concurrence.
  delete from public.sealed_sender_tokens
   where id = v_token.id
     and consumed_at is null;
  if not found then
    raise exception 'token_consumed';
  end if;

  delete from public.sealed_sender_tokens
   where expires_at <= statement_timestamp();
  delete from public.sealed_sender_messages
   where recipient_user_id = p_recipient_user_id
     and created_at < statement_timestamp() - interval '7 days';

  insert into public.sealed_sender_messages (
    conversation_id,
    recipient_user_id,
    anonymous_sender_tag,
    sealed_payload,
    sealed_header,
    context_id
  ) values (
    p_conversation_id,
    p_recipient_user_id,
    p_anonymous_sender_tag,
    p_sealed_payload,
    coalesce(p_sealed_header, '{}'::jsonb),
    p_context_id
  )
  on conflict (recipient_user_id, context_id)
    where context_id is not null
  do nothing
  returning id into v_message_id;

  if v_message_id is null then
    select id
      into v_message_id
      from public.sealed_sender_messages
     where recipient_user_id = p_recipient_user_id
       and context_id = p_context_id;
  end if;

  return v_message_id;
end;
$$;

revoke all on function public.relay_sealed_sender(
  text, text, integer, uuid, uuid, text, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.relay_sealed_sender(
  text, text, integer, uuid, uuid, text, text, text, jsonb
) to service_role;

create or replace function public.ack_sealed_sender_wakeups(
  p_message_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'not_authenticated';
  end if;

  -- Un ACK détruit le réveil : le serveur ne conserve pas un journal durable
  -- des contacts après la synchronisation de l'inbox Aegis.
  delete from public.sealed_sender_messages
   where recipient_user_id = v_user_id
     and id = any(coalesce(p_message_ids, array[]::uuid[]))
     and delivery_state = 'queued';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.ack_sealed_sender_wakeups(uuid[])
  from public, anon;
grant execute on function public.ack_sealed_sender_wakeups(uuid[])
  to authenticated;
grant execute on function public.ack_sealed_sender_wakeups(uuid[])
  to service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1
         from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'sealed_sender_messages'
     ) then
    alter publication supabase_realtime add table public.sealed_sender_messages;
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;
