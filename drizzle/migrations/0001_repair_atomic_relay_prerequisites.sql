-- Le relais atomique actuel garde ses enveloppes opaques dans un stockage
-- distinct. Le rejeu Aegis avait supprimé ces prérequis en juillet.
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
alter table public.sealed_sender_messages enable row level security;
revoke all on public.sealed_sender_messages from public, anon, authenticated;
grant select on public.sealed_sender_messages to authenticated;
grant all on public.sealed_sender_messages to service_role;
drop policy if exists "sealed messages recipient read" on public.sealed_sender_messages;
create policy "sealed messages recipient read" on public.sealed_sender_messages
  for select to authenticated using ((select auth.uid()) = recipient_user_id);
drop policy if exists "sealed messages authenticated insert" on public.sealed_sender_messages;

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

-- Ne pas ressusciter l'ancien RPC qui contournait le jeton à usage unique.
drop function if exists public.send_sealed_sender_message(uuid, uuid, text, text, jsonb);