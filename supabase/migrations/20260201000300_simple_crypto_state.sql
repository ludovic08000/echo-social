-- Simple crypto state provisioning
-- Server creates a stable crypto slot for each user.
-- Private E2EE keys remain client-side only.

create table if not exists public.user_crypto_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  key_slot_id uuid not null default gen_random_uuid(),
  identity_epoch integer not null default 1,
  status text not null default 'needs_client_key',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  client_key_published_at timestamptz
);

alter table public.user_crypto_state enable row level security;

do $$ begin
  create policy "user crypto state owner read" on public.user_crypto_state
    for select using (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "user crypto state owner update" on public.user_crypto_state
    for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
exception when duplicate_object then null; end $$;

create or replace function public.ensure_user_crypto_state()
returns public.user_crypto_state
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state public.user_crypto_state;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.user_crypto_state(user_id)
  values (auth.uid())
  on conflict (user_id) do update
    set updated_at = now()
  returning * into v_state;

  return v_state;
end;
$$;

create or replace function public.mark_user_crypto_ready(p_fingerprint text default null)
returns public.user_crypto_state
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_state public.user_crypto_state;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.user_crypto_state(
    user_id,
    status,
    client_key_published_at
  ) values (
    auth.uid(),
    'ready',
    now()
  )
  on conflict (user_id) do update
    set status = 'ready',
        client_key_published_at = now(),
        updated_at = now()
  returning * into v_state;

  return v_state;
end;
$$;

create or replace function public.create_crypto_state_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_crypto_state(user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_crypto_state_after_signup on auth.users;
create trigger create_crypto_state_after_signup
  after insert on auth.users
  for each row execute function public.create_crypto_state_for_new_user();

insert into public.user_crypto_state(user_id)
select id from auth.users
on conflict (user_id) do nothing;
