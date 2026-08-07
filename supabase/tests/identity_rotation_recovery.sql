begin;

select plan(15);

select ok(
  (select count(*) = 5
     from information_schema.columns
    where table_schema = 'public'
      and table_name = 'identity_rotation_requests'
      and column_name in (
        'recovery_blob',
        'recovery_iv',
        'recovery_blob_version',
        'recovery_attached_at',
        'recovery_cleared_at'
      )),
  'identity rotation encrypted recovery columns exist'
);

select ok(
  to_regprocedure('public.attach_identity_rotation_recovery_v1(uuid,uuid,text,text,integer)') is not null,
  'encrypted recovery attachment RPC exists'
);

select ok(
  to_regprocedure('public.finalize_identity_rotation_recovery_v1(uuid,uuid)') is not null,
  'encrypted recovery finalizer RPC exists'
);

select ok(
  coalesce((
    select procedure.prosecdef
      from pg_proc procedure
     where procedure.oid = to_regprocedure(
       'public.attach_identity_rotation_recovery_v1(uuid,uuid,text,text,integer)'
     )
  ), false),
  'recovery attachment RPC is SECURITY DEFINER'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.attach_identity_rotation_recovery_v1(uuid,uuid,text,text,integer)',
    'EXECUTE'
  ),
  'authenticated clients cannot attach recovery data directly'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.attach_identity_rotation_recovery_v1(uuid,uuid,text,text,integer)',
    'EXECUTE'
  ),
  'service_role can attach verified encrypted recovery data'
);

select ok(
  exists (
    select 1
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname = 'identity_rotation_requests'
       and trigger.tgname = 'require_identity_rotation_recovery_v1'
       and not trigger.tgisinternal
  ),
  'rotation commit has an encrypted recovery requirement trigger'
);

select ok(
  position(
    'identity_rotation_recovery_required'
    in pg_get_functiondef(to_regprocedure('public.require_identity_rotation_recovery_v1()'))
  ) > 0,
  'recovery requirement trigger fails closed'
);

select ok(
  position(
    'identity_rotation_recovery_already_attached'
    in pg_get_functiondef(to_regprocedure(
      'public.attach_identity_rotation_recovery_v1(uuid,uuid,text,text,integer)'
    ))
  ) > 0,
  'encrypted recovery attachment is immutable'
);

select ok(
  coalesce((
    select not procedure.prosecdef
      from pg_proc procedure
     where procedure.oid = to_regprocedure('public.guard_account_identity_rotation_v1()')
  ), false),
  'account identity downgrade guard is SECURITY INVOKER'
);

select ok(
  exists (
    select 1
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname = 'user_public_keys'
       and trigger.tgname = 'guard_account_identity_rotation_v1'
       and not trigger.tgisinternal
  ),
  'account public keys have a downgrade guard trigger'
);

select ok(
  exists (
    select 1
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname = 'user_public_keys'
       and trigger.tgname = 'guard_account_identity_deletion_v1'
       and not trigger.tgisinternal
  ),
  'account public identity deletion is guarded'
);

select ok(
  position(
    'new.is_active is distinct from old.is_active'
    in lower(pg_get_functiondef(to_regprocedure('public.guard_account_identity_rotation_v1()')))
  ) > 0,
  'authenticated clients cannot directly activate or deactivate a root'
);

select ok(
  position(
    'new.identity_epoch := v_active.identity_epoch'
    in lower(pg_get_functiondef(to_regprocedure('public.guard_account_identity_rotation_v1()')))
  ) > 0,
  'same-root legacy upserts inherit the authoritative server epoch'
);

select ok(
  position(
    'identity_rotation_verified_flow_required'
    in pg_get_functiondef(to_regprocedure('public.guard_account_identity_rotation_v1()'))
  ) > 0
  and position(
    'current_user'
    in pg_get_functiondef(to_regprocedure('public.guard_account_identity_rotation_v1()'))
  ) > 0,
  'downgrade guard blocks direct authenticated root replacement'
);

select * from finish();
rollback;
