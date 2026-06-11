create table if not exists public.sealed_sender_events (
  id bigserial primary key,
  conversation_id uuid not null,
  anonymous_sender_tag text not null,
  sender_hint_hash text,
  recipient_user_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists idx_sse_recipient on public.sealed_sender_events(recipient_user_id, created_at desc);
alter table public.sealed_sender_events enable row level security;
do $$ begin create policy "sse_recipient_read" on public.sealed_sender_events for select using (auth.uid() = recipient_user_id); exception when duplicate_object then null; end $$;
do $$ begin create policy "sse_auth_insert" on public.sealed_sender_events for insert with check (auth.role() = 'authenticated'); exception when duplicate_object then null; end $$;

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
create index if not exists idx_ssm_recipient on public.sealed_sender_messages(recipient_user_id, created_at desc);
alter table public.sealed_sender_messages enable row level security;
do $$ begin create policy "ssm_recipient_read" on public.sealed_sender_messages for select using (auth.uid() = recipient_user_id); exception when duplicate_object then null; end $$;
do $$ begin create policy "ssm_recipient_update" on public.sealed_sender_messages for update using (auth.uid() = recipient_user_id) with check (auth.uid() = recipient_user_id); exception when duplicate_object then null; end $$;

create table if not exists public.sealed_delivery_tokens (
  token_hash text primary key,
  recipient_user_id uuid not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_sdt_expires on public.sealed_delivery_tokens(expires_at);
alter table public.sealed_delivery_tokens enable row level security;

create table if not exists public.user_identity_change_events (
  id bigserial primary key,
  observer_user_id uuid not null references auth.users(id) on delete cascade,
  peer_user_id uuid not null,
  previous_fingerprint text,
  new_fingerprint text not null,
  acknowledged boolean not null default false,
  observed_at timestamptz not null default now(),
  acknowledged_at timestamptz
);
create index if not exists idx_uice_observer on public.user_identity_change_events(observer_user_id, observed_at desc);
alter table public.user_identity_change_events enable row level security;
do $$ begin create policy "uice_read" on public.user_identity_change_events for select using (auth.uid() = observer_user_id); exception when duplicate_object then null; end $$;
do $$ begin create policy "uice_insert" on public.user_identity_change_events for insert with check (auth.uid() = observer_user_id); exception when duplicate_object then null; end $$;
do $$ begin create policy "uice_update" on public.user_identity_change_events for update using (auth.uid() = observer_user_id) with check (auth.uid() = observer_user_id); exception when duplicate_object then null; end $$;

create table if not exists public.user_sender_certificates (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  identity_epoch integer not null,
  fingerprint text not null,
  payload text not null,
  signature text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, device_id, identity_epoch)
);
alter table public.user_sender_certificates enable row level security;
do $$ begin create policy "usc_public_read" on public.user_sender_certificates for select using (true); exception when duplicate_object then null; end $$;
do $$ begin create policy "usc_owner_insert" on public.user_sender_certificates for insert with check (auth.uid() = user_id); exception when duplicate_object then null; end $$;
do $$ begin create policy "usc_owner_update" on public.user_sender_certificates for update using (auth.uid() = user_id) with check (auth.uid() = user_id); exception when duplicate_object then null; end $$;