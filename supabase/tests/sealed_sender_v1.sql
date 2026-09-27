begin;

select plan(16);

select ok(
  to_regclass('public.sealed_sender_tokens') is not null,
  'sealed sender token table exists'
);

select ok(
  to_regprocedure('public.relay_sealed_sender(text,text,integer,uuid,uuid,text,text,text,jsonb)') is not null,
  'anonymous atomic relay RPC exists with the expected signature'
);

select ok(
  coalesce((
    select p.prosecdef
      from pg_proc p
     where p.oid = to_regprocedure('public.relay_sealed_sender(text,text,integer,uuid,uuid,text,text,text,jsonb)')
  ), false),
  'anonymous relay RPC is SECURITY DEFINER'
);

select ok(
  exists (
    select 1
      from pg_proc p
     where p.oid = to_regprocedure('public.relay_sealed_sender(text,text,integer,uuid,uuid,text,text,text,jsonb)')
       and coalesce(p.proconfig, array[]::text[]) @> array['search_path=pg_catalog, public']::text[]
  ),
  'anonymous relay RPC pins search_path'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.relay_sealed_sender(text,text,integer,uuid,uuid,text,text,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated clients cannot bypass the Edge relay'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.relay_sealed_sender(text,text,integer,uuid,uuid,text,text,text,jsonb)',
    'EXECUTE'
  ),
  'service role can execute the atomic relay'
);

select ok(
  to_regprocedure('public.ack_sealed_sender_wakeups(uuid[])') is not null,
  'recipient-scoped wakeup acknowledgement exists'
);

select ok(
  coalesce((
    select p.prosecdef
      from pg_proc p
     where p.oid = to_regprocedure('public.ack_sealed_sender_wakeups(uuid[])')
  ), false),
  'wakeup acknowledgement is SECURITY DEFINER'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.ack_sealed_sender_wakeups(uuid[])',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.ack_sealed_sender_wakeups(uuid[])',
    'EXECUTE'
  ),
  'only authenticated recipients can acknowledge wakeups'
);

select ok(
  not has_table_privilege('authenticated', 'public.sealed_sender_messages', 'INSERT'),
  'authenticated clients cannot directly insert sealed wakeups'
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
  exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'sealed_sender_messages'
       and column_name = 'context_id'
  ),
  'idempotent relay context exists'
);

select ok(
  to_regclass('public.sealed_sender_messages_recipient_context_uidx') is not null,
  'recipient and context are unique for retry safety'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.sealed_sender_messages'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.sealed_sender_events'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.sealed_sender_tokens'::regclass),
  'opaque relay storage enforces RLS'
);

select ok(
  not has_table_privilege('anon', 'public.sealed_sender_messages', 'SELECT')
  and not has_table_privilege('authenticated', 'public.sealed_sender_events', 'INSERT')
  and not has_table_privilege('authenticated', 'public.sealed_sender_messages', 'UPDATE'),
  'clients cannot mutate the opaque relay storage'
);

select ok(
  to_regprocedure('public.relay_sealed_sender_v1(text,text,integer,uuid,uuid,uuid,text,text,text,jsonb)') is null
  and to_regprocedure('public.send_sealed_sender_message(uuid,uuid,text,text,jsonb)') is null,
  'sender-bound and direct-send relay RPCs remain absent'
);

select * from finish();
rollback;
