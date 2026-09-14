begin;
select plan(7);

select has_column('public','user_devices','binding_status','binding state exists');
select has_column('public','user_devices','account_bound_at','account binding timestamp exists');
select has_column('public','user_devices','possession_verified_at','possession verification timestamp exists');
select col_not_null('public','user_devices','binding_status','binding is never implicitly null');
select col_default_is('public','user_devices','binding_status','pending','new devices are not trusted by default');
select ok(to_regprocedure('public.finalize_device_account_binding_pre_signal_validation(uuid,text,text)') is null,
  'binding does not depend on an unverified historical finalizer');
select ok(
  has_function_privilege('service_role','public.finalize_device_account_binding(uuid,text,text)','execute')
  and not has_function_privilege('authenticated','public.finalize_device_account_binding(uuid,text,text)','execute')
  and not has_function_privilege('anon','public.finalize_device_account_binding(uuid,text,text)','execute'),
  'only the server can call the account-scoped binding finalizer directly');

select * from finish();
rollback;
