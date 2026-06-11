-- Advanced E2EE architecture support
-- Safe/idempotent migration for identity epochs, devices, sender certs,
-- signed manifests, sealed sender metadata and transparency logs.

create table if not exists public.user_identity_epochs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  epoch integer not null default 1,
  fingerprint text not null,
  reason text not null default 'initial',
  created_at timestamptz not null default now(),
  unique(user_id, epoch)
);

alter table public.user_public_keys
  add column if not exists identity_epoch integer not null default 1;

create table if not exists public.user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  fingerprint text not null,
  identity_epoch integer not null default 1,
  signed_device_list jsonb,
  signature text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique(user_id, device_id)
);

create table if not exists public.user_device_manifests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null,
  signature text not null,
  signed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_sender_certificates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  identity_epoch integer not null default 1,
  fingerprint text not null,
  payload jsonb not null,
  signature text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique(user_id, device_id, identity_epoch)
);

create table if not exists public.sealed_sender_events (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid,
  anonymous_sender_tag text not null,
  sender_hint_hash text,
  recipient_user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.e2ee_transparency_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  event_type text not null,
  fingerprint text,
  identity_epoch integer,
  device_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_user_identity_epochs_user on public.user_identity_epochs(user_id, epoch desc);
create index if not exists idx_user_devices_user_active on public.user_devices(user_id, revoked_at, last_seen_at desc);
create index if not exists idx_sender_certs_user_expires on public.user_sender_certificates(user_id, expires_at desc);
create index if not exists idx_sealed_sender_recipient on public.sealed_sender_events(recipient_user_id, created_at desc);
create index if not exists idx_transparency_user on public.e2ee_transparency_log(user_id, created_at desc);

alter table public.user_identity_epochs enable row level security;
alter table public.user_devices enable row level security;
alter table public.user_device_manifests enable row level security;
alter table public.user_sender_certificates enable row level security;
alter table public.sealed_sender_events enable row level security;
alter table public.e2ee_transparency_log enable row level security;

do $$ begin
  create policy "identity epochs own read" on public.user_identity_epochs
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "identity epochs own insert" on public.user_identity_epochs
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "devices owner manage" on public.user_devices
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "device manifests owner manage" on public.user_device_manifests
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "sender certs owner manage" on public.user_sender_certificates
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "sender certs authenticated read" on public.user_sender_certificates
    for select using (auth.role() = 'authenticated');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "sealed sender recipient read" on public.sealed_sender_events
    for select using (auth.uid() = recipient_user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "sealed sender authenticated insert" on public.sealed_sender_events
    for insert with check (auth.role() = 'authenticated');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "transparency owner read" on public.e2ee_transparency_log
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "transparency owner insert" on public.e2ee_transparency_log
    for insert with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;
