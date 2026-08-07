begin;

-- Keep legacy and derived account-identity registries aligned with the single
-- active row in user_public_keys. Direct root changes are already blocked by
-- guard_account_identity_rotation_v1; this trigger only mirrors verified state.
create or replace function public.sync_active_account_identity_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_primary_device_id text;
begin
  if new.is_active is not true then
    return new;
  end if;

  insert into public.user_crypto_state (
    user_id,
    fingerprint,
    identity_epoch,
    status,
    client_key_published_at,
    updated_at
  ) values (
    new.user_id,
    new.fingerprint,
    new.identity_epoch,
    'ready',
    clock_timestamp(),
    clock_timestamp()
  )
  on conflict (user_id) do update
  set fingerprint = excluded.fingerprint,
      identity_epoch = excluded.identity_epoch,
      status = 'ready',
      client_key_published_at = excluded.client_key_published_at,
      updated_at = excluded.updated_at;

  select device.device_id
    into v_primary_device_id
    from public.user_devices device
   where device.user_id = new.user_id
     and device.is_active = true
     and device.approval_status = 'approved'
     and device.revoked_at is null
     and device.crypto_invalid_at is null
   order by device.is_primary desc, device.last_seen_at desc
   limit 1;

  if v_primary_device_id is not null then
    insert into public.user_identity_roots (
      user_id,
      generation,
      identity_pub_b64,
      primary_device_id,
      created_at,
      updated_at
    ) values (
      new.user_id,
      new.identity_epoch,
      new.identity_key,
      v_primary_device_id,
      clock_timestamp(),
      clock_timestamp()
    )
    on conflict (user_id) do update
    set generation = excluded.generation,
        identity_pub_b64 = excluded.identity_pub_b64,
        primary_device_id = excluded.primary_device_id,
        updated_at = excluded.updated_at;
  else
    update public.user_identity_roots
       set generation = new.identity_epoch,
           identity_pub_b64 = new.identity_key,
           updated_at = clock_timestamp()
     where user_id = new.user_id;
  end if;

  return new;
end;
$$;

revoke all on function public.sync_active_account_identity_v1()
  from public, anon, authenticated;

drop trigger if exists sync_active_account_identity_v1
  on public.user_public_keys;
create trigger sync_active_account_identity_v1
after insert or update of
  identity_key,
  fingerprint,
  identity_epoch,
  is_active
on public.user_public_keys
for each row
execute function public.sync_active_account_identity_v1();

-- The verified rotation updates the surviving device after the account root.
-- Refresh the legacy primary-device pointer once that device is promoted.
create or replace function public.sync_identity_root_primary_device_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.is_active = true
     and new.approval_status = 'approved'
     and new.revoked_at is null
     and new.crypto_invalid_at is null then
    update public.user_identity_roots
       set primary_device_id = new.device_id,
           generation = greatest(generation, new.identity_epoch),
           updated_at = clock_timestamp()
     where user_id = new.user_id;
  end if;
  return new;
end;
$$;

revoke all on function public.sync_identity_root_primary_device_v1()
  from public, anon, authenticated;

drop trigger if exists sync_identity_root_primary_device_v1
  on public.user_devices;
create trigger sync_identity_root_primary_device_v1
after insert or update of
  identity_epoch,
  is_active,
  approval_status,
  revoked_at,
  crypto_invalid_at
on public.user_devices
for each row
execute function public.sync_identity_root_primary_device_v1();

-- Align existing derived rows immediately on deployment.
update public.user_crypto_state state
   set fingerprint = key.fingerprint,
       identity_epoch = key.identity_epoch,
       status = 'ready',
       updated_at = clock_timestamp()
  from public.user_public_keys key
 where key.user_id = state.user_id
   and key.is_active = true;

update public.user_identity_roots root
   set identity_pub_b64 = key.identity_key,
       generation = key.identity_epoch,
       updated_at = clock_timestamp()
  from public.user_public_keys key
 where key.user_id = root.user_id
   and key.is_active = true;

commit;
