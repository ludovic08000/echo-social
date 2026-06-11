-- E2EE trusted browser/device registry.
-- Public metadata only. Never store PINs, private keys, decrypted backups, or key seeds here.

create table if not exists public.user_trusted_devices (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,

  device_name text,
  browser_name text,
  browser_version text,
  os_name text,
  os_version text,
  platform text,

  user_agent_hash text,
  client_hints_hash text,

  timezone text,
  country text,
  region text,
  city text,
  ip_hash text,

  e2ee_public_key text,
  e2ee_identity_fingerprint text,

  trust_status text not null default 'pending'
    check (trust_status in ('pending', 'trusted', 'revoked', 'blocked')),

  risk_level text not null default 'unknown'
    check (risk_level in ('unknown', 'low', 'medium', 'high', 'blocked')),

  risk_reasons text[] not null default '{}',

  signature text,
  signed_at timestamptz,

  last_seen_at timestamptz not null default now(),
  trusted_at timestamptz,
  revoked_at timestamptz,
  blocked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique(user_id, device_id)
);

create index if not exists user_trusted_devices_user_id_idx
  on public.user_trusted_devices(user_id);

create index if not exists user_trusted_devices_status_idx
  on public.user_trusted_devices(user_id, trust_status);

create or replace function public.touch_user_trusted_devices_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_user_trusted_devices_updated_at
on public.user_trusted_devices;

create trigger touch_user_trusted_devices_updated_at
before update on public.user_trusted_devices
for each row
execute function public.touch_user_trusted_devices_updated_at();

alter table public.user_trusted_devices enable row level security;

drop policy if exists "trusted devices select own"
on public.user_trusted_devices;

create policy "trusted devices select own"
on public.user_trusted_devices
for select
using (auth.uid() = user_id);

drop policy if exists "trusted devices insert own pending"
on public.user_trusted_devices;

create policy "trusted devices insert own pending"
on public.user_trusted_devices
for insert
with check (
  auth.uid() = user_id
  and trust_status in ('pending', 'trusted')
);

drop policy if exists "trusted devices update own safe fields"
on public.user_trusted_devices;

create policy "trusted devices update own safe fields"
on public.user_trusted_devices
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "trusted devices delete own"
on public.user_trusted_devices;

create policy "trusted devices delete own"
on public.user_trusted_devices
for delete
using (auth.uid() = user_id);

-- Optional hardening RPC: revoke a browser/device from the current account.
create or replace function public.revoke_my_trusted_device(_device_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.user_trusted_devices
  set trust_status = 'revoked',
      revoked_at = now(),
      updated_at = now()
  where user_id = auth.uid()
    and device_id = _device_id;
end;
$$;
