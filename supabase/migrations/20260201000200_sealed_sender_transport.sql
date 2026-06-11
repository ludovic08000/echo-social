-- Sealed sender transport foundation
-- Goal: recipient-routable opaque envelopes without exposing sender_id in the message row.
-- This is not a full metadata-resistant network, but it removes sender identity
-- from the application-level transport record and keeps only opaque sealed tags.

create table if not exists public.sealed_sender_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  anonymous_sender_tag text not null,
  sealed_payload text not null,
  sealed_header jsonb not null default '{}'::jsonb,
  delivery_state text not null default 'queued',
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  read_at timestamptz
);

create index if not exists idx_sealed_sender_messages_recipient
  on public.sealed_sender_messages(recipient_user_id, created_at desc);

create index if not exists idx_sealed_sender_messages_conversation
  on public.sealed_sender_messages(conversation_id, created_at desc);

alter table public.sealed_sender_messages enable row level security;

do $$ begin
  create policy "sealed messages recipient read" on public.sealed_sender_messages
    for select using (auth.uid() = recipient_user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "sealed messages authenticated insert" on public.sealed_sender_messages
    for insert with check (auth.role() = 'authenticated');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "sealed messages recipient update state" on public.sealed_sender_messages
    for update using (auth.uid() = recipient_user_id)
    with check (auth.uid() = recipient_user_id);
exception when duplicate_object then null; end $$;

create or replace function public.send_sealed_sender_message(
  p_conversation_id uuid,
  p_recipient_user_id uuid,
  p_anonymous_sender_tag text,
  p_sealed_payload text,
  p_sealed_header jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.sealed_sender_messages(
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
  ) returning id into v_id;

  insert into public.sealed_sender_events(
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

  return v_id;
end;
$$;

create or replace function public.mark_sealed_sender_delivered(p_message_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update public.sealed_sender_messages
  set delivery_state = 'delivered', delivered_at = now()
  where id = p_message_id and recipient_user_id = auth.uid();
end;
$$;
