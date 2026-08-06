begin;

select plan(14);

select ok(
  to_regprocedure('public.reject_plaintext_zeus_messenger()') is not null,
  'Zeus plaintext messenger guard exists'
);

select ok(
  coalesce((
    select procedure.prosecdef
      from pg_proc procedure
     where procedure.oid = to_regprocedure('public.reject_plaintext_zeus_messenger()')
  ), false),
  'Zeus messenger guard is SECURITY DEFINER'
);

select ok(
  exists (
    select 1
      from pg_proc procedure
     where procedure.oid = to_regprocedure('public.reject_plaintext_zeus_messenger()')
       and coalesce(procedure.proconfig, array[]::text[]) @> array['search_path=pg_catalog, public']::text[]
  ),
  'Zeus messenger guard pins search_path'
);

select ok(
  exists (
    select 1
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname = 'messages'
       and trigger.tgname = 'reject_plaintext_zeus_messenger'
       and not trigger.tgisinternal
       and trigger.tgenabled = 'O'
  ),
  'messages table has an enabled Zeus plaintext guard trigger'
);

select ok(
  to_regprocedure('public.reject_zeus_messenger_participant()') is not null,
  'Zeus messenger participant guard exists'
);

select ok(
  coalesce((
    select procedure.prosecdef
      from pg_proc procedure
     where procedure.oid = to_regprocedure('public.reject_zeus_messenger_participant()')
  ), false),
  'Zeus participant guard is SECURITY DEFINER'
);

select ok(
  exists (
    select 1
      from pg_proc procedure
     where procedure.oid = to_regprocedure('public.reject_zeus_messenger_participant()')
       and coalesce(procedure.proconfig, array[]::text[]) @> array['search_path=pg_catalog, public']::text[]
  ),
  'Zeus participant guard pins search_path'
);

select ok(
  exists (
    select 1
      from pg_trigger trigger
      join pg_class relation on relation.oid = trigger.tgrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname = 'conversation_participants'
       and trigger.tgname = 'reject_zeus_messenger_participant'
       and not trigger.tgisinternal
       and trigger.tgenabled = 'O'
  ),
  'conversation participants have an enabled Zeus guard trigger'
);

select ok(
  position(
    'insert into public.messages'
    in lower(pg_get_functiondef(to_regprocedure('public.zeus_welcome_new_user()')))
  ) = 0,
  'Zeus welcome flow no longer inserts plaintext messages'
);

select ok(
  position(
    'insert into public.conversations'
    in lower(pg_get_functiondef(to_regprocedure('public.zeus_welcome_new_user()')))
  ) = 0,
  'Zeus welcome flow no longer creates messenger conversations'
);

select ok(
  to_regclass('public.zeus_messenger_blocked_conversations') is not null,
  'durable Zeus blocked-conversation marker exists'
);

select ok(
  coalesce((
    select relation.relrowsecurity
      from pg_class relation
      join pg_namespace namespace on namespace.oid = relation.relnamespace
     where namespace.nspname = 'public'
       and relation.relname = 'zeus_messenger_blocked_conversations'
  ), false),
  'durable Zeus marker has RLS enabled'
);

select ok(
  not has_table_privilege('anon', 'public.zeus_messenger_blocked_conversations', 'SELECT')
  and not has_table_privilege('anon', 'public.zeus_messenger_blocked_conversations', 'INSERT')
  and not has_table_privilege('authenticated', 'public.zeus_messenger_blocked_conversations', 'SELECT')
  and not has_table_privilege('authenticated', 'public.zeus_messenger_blocked_conversations', 'INSERT'),
  'client roles have no direct access to the durable Zeus marker'
);

select ok(
  position(
    'zeus_messenger_blocked_conversations'
    in lower(pg_get_functiondef(to_regprocedure('public.reject_plaintext_zeus_messenger()')))
  ) > 0,
  'message guard consults the durable blocked-conversation marker'
);

select * from finish();
rollback;
