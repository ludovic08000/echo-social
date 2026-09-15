begin;
select plan(1);
-- Le helper ne doit ni exposer la quarantaine ni ignorer l'identifiant du compte.
do $test$
declare
  owner_id uuid := gen_random_uuid();
  other_id uuid := gen_random_uuid();
  target_id text := 'quarantine-helper-test';
begin
  insert into public.invalid_e2ee_devices(user_id, device_id, reason)
  values(owner_id, target_id, 'test');
  if public.is_invalid_e2ee_device(owner_id, target_id) is distinct from true then
    raise exception 'QUARANTINED_DEVICE_NOT_FILTERED';
  end if;
  if public.is_invalid_e2ee_device(other_id, target_id) is distinct from false then
    raise exception 'QUARANTINE_CROSSES_ACCOUNT_BOUNDARY';
  end if;
  if public.is_invalid_e2ee_device(owner_id, target_id || '-other') is distinct from false then
    raise exception 'QUARANTINE_CROSSES_DEVICE_BOUNDARY';
  end if;
  if has_function_privilege('anon', 'public.is_invalid_e2ee_device(uuid,text)', 'execute')
    or has_function_privilege('authenticated', 'public.is_invalid_e2ee_device(uuid,text)', 'execute') then
    raise exception 'INTERNAL_QUARANTINE_HELPER_EXPOSED';
  end if;
end $test$;
select pass('quarantine helper enforces owner/device scope and internal privileges');
select * from finish();
rollback;
