begin;

select plan(16);

select ok(
  to_regclass('public.identity_rotation_requests') is not null,
  'identity rotation request table exists'
);

select ok(
  coalesce((
    select relation.relrowsecurity
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname = 'identity_rotation_requests'
  ), false),
  'identity rotation requests have RLS enabled'
);

select ok(
  not has_table_privilege('anon', 'public.identity_rotation_requests', 'SELECT')
  and not has_table_privilege('authenticated', 'public.identity_rotation_requests', 'SELECT')
  and not has_table_privilege('authenticated', 'public.identity_rotation_requests', 'INSERT'),
  'client roles cannot access identity rotation requests directly'
);

select ok(
  exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'user_public_keys'
       and column_name = 'identity_epoch'
  ),
  'account public identity carries its epoch'
);

select ok(
  exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'user_devices'
       and column_name = 'identity_epoch'
  ),
  'device authorization carries the account epoch'
);

select ok(
  to_regprocedure('public.begin_identity_rotation_v1(uuid,integer,text,text,text,text,text,text,text)') is not null,
  'begin identity rotation RPC exists'
);

select ok(
  to_regprocedure('public.commit_identity_rotation_v1(uuid,uuid,text,text,text,text)') is not null,
  'commit identity rotation RPC exists'
);

select ok(
  to_regprocedure('public.cancel_identity_rotation_v1(uuid,uuid)') is not null,
  'cancel identity rotation RPC exists'
);

select ok(
  to_regprocedure('public.get_identity_rotation_status_v1(uuid,uuid)') is not null,
  'identity rotation status RPC exists'
);

select ok(
  coalesce((
    select procedure.prosecdef
      from pg_proc procedure
     where procedure.oid = to_regprocedure(
       'public.commit_identity_rotation_v1(uuid,uuid,text,text,text,text)'
     )
  ), false),
  'identity rotation commit is SECURITY DEFINER'
);

select ok(
  exists (
    select 1
      from pg_proc procedure
     where procedure.oid = to_regprocedure(
       'public.commit_identity_rotation_v1(uuid,uuid,text,text,text,text)'
     )
       and coalesce(procedure.proconfig, array[]::text[])
           @> array['search_path=pg_catalog, public']::text[]
  ),
  'identity rotation commit pins search_path'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.commit_identity_rotation_v1(uuid,uuid,text,text,text,text)',
    'EXECUTE'
  ),
  'authenticated clients cannot call the atomic commit directly'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.commit_identity_rotation_v1(uuid,uuid,text,text,text,text)',
    'EXECUTE'
  ),
  'service_role can call the verified atomic commit'
);

select ok(
  position(
    'device_id <> p_approver_device_id'
    in pg_get_functiondef(to_regprocedure(
      'public.commit_identity_rotation_v1(uuid,uuid,text,text,text,text)'
    ))
  ) > 0,
  'commit revokes every non-authorizing device'
);

select ok(
  position(
    'insert into public.e2ee_transparency_log'
    in lower(pg_get_functiondef(to_regprocedure(
      'public.commit_identity_rotation_v1(uuid,uuid,text,text,text,text)'
    )))
  ) > 0,
  'commit appends a transparency event'
);

select ok(
  position(
    'insert into public.user_identity_change_events'
    in lower(pg_get_functiondef(to_regprocedure(
      'public.commit_identity_rotation_v1(uuid,uuid,text,text,text,text)'
    )))
  ) > 0,
  'commit creates peer-visible identity change events'
);

select * from finish();
rollback;
