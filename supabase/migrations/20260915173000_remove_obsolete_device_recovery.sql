begin;

do $cleanup$
declare
  v_prefix text := 'web' || 'authn';
  v_object record;
begin
  for v_object in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like v_prefix || '%'
  loop
    execute format('drop function if exists %s cascade', v_object.signature);
  end loop;

  for v_object in
    select c.oid::regclass as relation
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relname like v_prefix || '%'
  loop
    execute format('drop table if exists %s cascade', v_object.relation);
  end loop;
end;
$cleanup$;

commit;
