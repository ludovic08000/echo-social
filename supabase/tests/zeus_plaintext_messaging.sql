begin;

select plan(6);

select ok(
  to_regprocedure('public.reject_plaintext_zeus_messenger()') is not null,
  'Zeus plaintext messenger guard exists'
);

select ok(
  coalesce((
    select p.prosecdef
      from pg_proc p
     where p.oid = to_regprocedure('public.reject_plaintext_zeus_messenger()')
  ), false),
  'Zeus messenger guard is SECURITY DEFINER'
);

select ok(
  exists (
    select 1
      from pg_proc p
     where p.oid = to_regprocedure('public.reject_plaintext_zeus_messenger()')
       and coalesce(p.proconfig, array[]::text[]) @> array['search_path=pg_catalog, public']::text[]
  ),
  'Zeus messenger guard pins search_path'
);

select ok(
  exists (
    select 1
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'messages'
       and t.tgname = 'reject_plaintext_zeus_messenger'
       and not t.tgisinternal
       and t.tgenabled = 'O'
  ),
  'messages table has an enabled Zeus plaintext guard trigger'
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

select * from finish();
rollback;
