begin;

alter table public.user_crypto_state add column if not exists fingerprint text;

-- Réparer aussi les bases ayant déjà appliqué les migrations historiques.
drop trigger if exists sync_identity_root_primary_device_v1 on public.user_devices;
drop function if exists public.sync_identity_root_primary_device_v1();

create or replace function public.sync_active_account_identity_v1()
returns trigger
language plpgsql security definer
set search_path = pg_catalog, public
as $$
begin
  if new.is_active is not true then return new; end if;
  insert into public.user_crypto_state (
    user_id, fingerprint, identity_epoch, status, client_key_published_at, updated_at
  ) values (
    new.user_id, new.fingerprint, new.identity_epoch, 'ready', clock_timestamp(), clock_timestamp()
  ) on conflict (user_id) do update
  set fingerprint = excluded.fingerprint,
      identity_epoch = excluded.identity_epoch,
      status = 'ready',
      client_key_published_at = excluded.client_key_published_at,
      updated_at = excluded.updated_at;
  return new;
end;
$$;
revoke all on function public.sync_active_account_identity_v1() from public, anon, authenticated;

create or replace function public.is_invalid_e2ee_device(p_user_id uuid, p_device_id text)
returns boolean language sql stable security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.invalid_e2ee_devices bad
    where bad.user_id = p_user_id and bad.device_id = p_device_id
  );
$$;
revoke all on function public.is_invalid_e2ee_device(uuid, text) from public, anon, authenticated;
grant execute on function public.is_invalid_e2ee_device(uuid, text) to service_role;

commit;
