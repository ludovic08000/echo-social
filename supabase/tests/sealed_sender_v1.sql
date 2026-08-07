begin;

select plan(9);

select ok(
  to_regclass('public.sealed_sender_tokens') is not null,
  'sealed_sender_tokens table exists'
);

select ok(
  to_regprocedure('public.relay_sealed_sender_v1(text,text,integer,uuid,uuid,uuid,text,text,text,jsonb)') is not null,
  'atomic relay RPC exists with the expected signature'
);

select ok(
  coalesce((
    select p.prosecdef
      from pg_proc p
     where p.oid = to_regprocedure('public.relay_sealed_sender_v1(text,text,integer,uuid,uuid,uuid,text,text,text,jsonb)')
  ), false),
  'atomic relay RPC is SECURITY DEFINER'
);

select ok(
  exists (
    select 1
      from pg_proc p
     where p.oid = to_regprocedure('public.relay_sealed_sender_v1(text,text,integer,uuid,uuid,uuid,text,text,text,jsonb)')
       and coalesce(p.proconfig, array[]::text[]) @> array['search_path=pg_catalog, public']::text[]
  ),
  'atomic relay RPC pins search_path'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.relay_sealed_sender_v1(text,text,integer,uuid,uuid,uuid,text,text,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated clients cannot execute the service-role relay RPC'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.relay_sealed_sender_v1(text,text,integer,uuid,uuid,uuid,text,text,text,jsonb)',
    'EXECUTE'
  ),
  'service_role can execute the atomic relay RPC'
);

select ok(
  not has_table_privilege('authenticated', 'public.sealed_sender_messages', 'INSERT'),
  'authenticated clients cannot directly insert sealed messages'
);

select ok(
  not exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename = 'sealed_sender_messages'
       and policyname = 'sealed messages authenticated insert'
  ),
  'legacy authenticated insert policy is absent'
);

select ok(
  (select count(*) = 7
     from information_schema.columns
    where table_schema = 'public'
      and table_name = 'sealed_sender_tokens'
      and column_name in (
        'nonce',
        'protocol_version',
        'sender_user_id',
        'recipient_user_id',
        'conversation_id',
        'issued_at',
        'consumed_at'
      )),
  'token context and consumption columns exist'
);

select * from finish();
rollback;
