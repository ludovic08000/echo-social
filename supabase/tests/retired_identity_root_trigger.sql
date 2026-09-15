begin;
select plan(2);

-- Aucun ancien trigger ne doit pouvoir réintroduire la racine primaire retirée.
select is(
  (select count(*) from pg_trigger
   where tgrelid = 'public.user_devices'::regclass
     and tgname in ('aegis_reconcile_device_root', 'trg_aegis_reconcile_device_root')),
  0::bigint,
  'legacy identity-root triggers are removed'
);
select ok(
  to_regprocedure('public.trg_aegis_reconcile_device_root()') is null,
  'legacy identity-root trigger function is removed'
);

select * from finish();
rollback;
