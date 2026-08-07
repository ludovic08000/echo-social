begin;

select plan(8);

select ok(
  to_regprocedure('public.sync_active_account_identity_v1()') is not null,
  'active identity alignment function exists'
);

select ok(
  coalesce((
    select procedure.prosecdef
      from pg_proc procedure
     where procedure.oid = to_regprocedure('public.sync_active_account_identity_v1()')
  ), false),
  'active identity alignment function is SECURITY DEFINER'
);

select ok(
  exists (
    select 1
      from pg_proc procedure
     where procedure.oid = to_regprocedure('public.sync_active_account_identity_v1()')
       and coalesce(procedure.proconfig, array[]::text[])
           @> array['search_path=pg_catalog, public']::text[]
  ),
  'active identity alignment pins search_path'
);

select ok(
  exists (
    select 1
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname = 'user_public_keys'
       and trigger.tgname = 'sync_active_account_identity_v1'
       and not trigger.tgisinternal
  ),
  'active public identity has a derived-state alignment trigger'
);

select ok(
  position(
    'insert into public.user_crypto_state'
    in lower(pg_get_functiondef(to_regprocedure('public.sync_active_account_identity_v1()')))
  ) > 0,
  'active root aligns user_crypto_state'
);

select ok(
  position(
    'insert into public.user_identity_roots'
    in lower(pg_get_functiondef(to_regprocedure('public.sync_active_account_identity_v1()')))
  ) > 0,
  'active root aligns the legacy identity-root registry'
);

select ok(
  to_regprocedure('public.sync_identity_root_primary_device_v1()') is not null
  and exists (
    select 1
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname = 'user_devices'
       and trigger.tgname = 'sync_identity_root_primary_device_v1'
       and not trigger.tgisinternal
  ),
  'surviving device refreshes the legacy primary-device pointer'
);

select ok(
  position(
    'generation = greatest(generation, new.identity_epoch)'
    in lower(pg_get_functiondef(to_regprocedure('public.sync_identity_root_primary_device_v1()')))
  ) > 0,
  'device alignment never lowers the legacy identity generation'
);

select * from finish();
rollback;
