begin;

-- La racine primaire a été retirée : ne synchroniser que l'état de compte actif.
create or replace function public.sync_active_account_identity_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.is_active is not true then
    return new;
  end if;
  insert into public.user_crypto_state (
    user_id, fingerprint, identity_epoch, status, client_key_published_at, updated_at
  ) values (
    new.user_id, new.fingerprint, new.identity_epoch, 'ready', clock_timestamp(), clock_timestamp()
  )
  on conflict (user_id) do update
  set fingerprint = excluded.fingerprint,
      identity_epoch = excluded.identity_epoch,
      status = 'ready',
      client_key_published_at = excluded.client_key_published_at,
      updated_at = excluded.updated_at;
  return new;
end;
$$;
revoke all on function public.sync_active_account_identity_v1() from public, anon, authenticated;

drop trigger if exists sync_active_account_identity_v1 on public.user_public_keys;
create trigger sync_active_account_identity_v1
after insert or update of identity_key, fingerprint, identity_epoch, is_active
on public.user_public_keys
for each row execute function public.sync_active_account_identity_v1();

drop trigger if exists sync_identity_root_primary_device_v1 on public.user_devices;
drop function if exists public.sync_identity_root_primary_device_v1();

update public.user_crypto_state state
set fingerprint = key.fingerprint,
    identity_epoch = key.identity_epoch,
    status = 'ready',
    updated_at = clock_timestamp()
from public.user_public_keys key
where key.user_id = state.user_id and key.is_active = true;

commit;
