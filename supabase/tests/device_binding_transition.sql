begin;
select plan(1);

-- Vecteurs synthétiques signés avec node:crypto ; aucune clé privée conservée.
-- Tous les enregistrements sont annulés en fin de test.
do $test$
declare
  owner_id uuid := 'a7d6fd20-b4f0-4e78-ab36-809822db5e02';
  target_id text := 'dev_a7d6fd20b4f04e78ab36809822db5e02';
  signature text := 'MLK+L1Cz/sISkLHzuwtN7Cf0x6MMxPcdo+0OCb9+FyYxeYfNXHkEMzar12/l5Ydue9yDfqpTUPAwqbpRcp2iBg==';
  result jsonb;
  device public.user_devices%rowtype;
begin
  insert into auth.users(id,email) values(owner_id,'binding-transition@example.invalid');
  insert into public.user_public_keys(user_id,identity_key,signing_key,fingerprint,
    identity_binding_signature,identity_binding_version,kem_type)
  values(owner_id,'34dOzPr6jbIhcYp4pmsJzhrsgm/3gphfCWmGvKJTFHE=',
    'mk/EE/0nfJEhKXcy53wrJgLySSmw9JTGZeFc1xUARl0=',
    'A6A3C321 7A439566 2B447CB6 4AD9F7C3 FAF61107',
    'yCLNJQrZU0wWMWIUr3M8XO1TASehOD/zR4xuFKSfG6ptf7YhELTVr8dJK7VZpnuzSc6twc2+xKPLchpC8z2TDg==',1,'X25519');
  insert into public.user_devices(user_id,device_id,device_public_key,device_signing_key,
    approval_status,lifecycle_status,is_active)
  values(owner_id,target_id,'ckrC5pzI9vunnT2yr1fviZA5ZCzV9OXlU+gF+cf/iqE=',
    'gbVio/ZnAu92RgqyDWiTuB7Z1IRhwUpboo1ZZB/uCiE=','approved','approved',true);

  result := public.finalize_device_account_binding(owner_id,target_id,signature);
  if result->>'code' is distinct from 'DEVICE_POSSESSION_NOT_VERIFIED' then
    raise exception 'BINDING_ACCEPTED_WITHOUT_POSSESSION:%',result;
  end if;
  update public.user_devices set possession_verified_at=now() where user_id=owner_id and device_id=target_id;
  result := public.finalize_device_account_binding(owner_id,target_id,repeat('A',86)||'==');
  if result->>'code' is distinct from 'DEVICE_AUTHORIZATION_SIGNATURE_INVALID' then
    raise exception 'INVALID_AUTHORIZATION_ACCEPTED:%',result;
  end if;
  select * into device from public.user_devices where user_id=owner_id and device_id=target_id;
  if device.binding_status <> 'pending' or device.account_bound_at is not null then
    raise exception 'REJECTED_BINDING_CHANGED_TRUST';
  end if;

  result := public.finalize_device_account_binding(owner_id,target_id,signature);
  if result->>'code' is distinct from 'DEVICE_ACCOUNT_BOUND' or result->>'ok' is distinct from 'true' then
    raise exception 'VALID_BINDING_FAILED:%',result;
  end if;
  select * into device from public.user_devices where user_id=owner_id and device_id=target_id;
  if device.binding_status <> 'bound' or device.account_bound_at is null
    or device.device_authorization_signature is distinct from signature
    or device.lifecycle_status <> 'syncing' or device.routing_status <> 'repairing'
    or device.crypto_invalid_at is not null then
    raise exception 'BINDING_TRANSITION_INCOMPLETE_OR_PREMATURELY_READY';
  end if;
  result := public.finalize_device_account_binding(owner_id,target_id,signature);
  if result->>'existing' is distinct from 'true' then raise exception 'BINDING_NOT_IDEMPOTENT'; end if;
  result := public.finalize_device_account_binding(gen_random_uuid(),target_id,signature);
  if result->>'code' is distinct from 'DEVICE_NOT_FOUND' then raise exception 'BINDING_CROSSES_ACCOUNT'; end if;

  update public.user_devices set revoked_at=now(),revoke_reason='manual' where user_id=owner_id and device_id=target_id;
  result := public.finalize_device_account_binding(owner_id,target_id,signature);
  if result->>'code' is distinct from 'DEVICE_NOT_APPROVED' then raise exception 'REVOKED_DEVICE_REBOUND'; end if;
end $test$;

select pass('signed binding, possession, quarantine recovery, idempotence, ownership and revocation');
select * from finish();
rollback;
