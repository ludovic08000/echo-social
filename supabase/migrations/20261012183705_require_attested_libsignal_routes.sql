begin;

-- Un appareil ancien sans preuve Libsignal signée ne bloque pas les appareils
-- prêts. La preuve persistante ne remplace jamais l'autorisation actuelle et
-- reste valable après épuisement des préclés, sans toucher aux clés privées.
create or replace function public.get_sesame_device_list(p_user_id uuid)
returns table(
  device_id text, device_public_key text, device_signing_key text,
  device_authorization_signature text, last_seen_at timestamptz,
  account_identity_key text, account_signing_key text, account_fingerprint text,
  account_binding_signature text, account_binding_version integer, is_routable boolean
)
language sql stable security definer set search_path = public, pg_temp
as $function$
  select device.device_id, device.device_public_key, device.device_signing_key,
    device.device_authorization_signature, device.last_seen_at,
    account.identity_key, account.signing_key, account.fingerprint,
    account.identity_binding_signature, account.identity_binding_version,
    coalesce((device.approval_status = 'approved' and device.is_active = true
      and device.revoked_at is null and device.stale_at is null
      and device.crypto_invalid_at is null and device.binding_status = 'bound'
      and device.account_bound_at is not null and device.routing_status = 'ready'
      and device.libsignal_device_number between 1 and 127
      and nullif(trim(device.device_public_key), '') is not null
      and nullif(trim(device.device_signing_key), '') is not null
      and nullif(trim(device.device_authorization_signature), '') is not null
      and account.user_id is not null and account.is_active = true
      and public.aegis_verify_account_binding(account.identity_key, account.signing_key,
        account.fingerprint, account.identity_binding_signature, account.identity_binding_version)
      and public.aegis_verify_device_authorization(device.user_id, device.device_id,
        device.device_public_key, device.device_signing_key, device.device_authorization_signature,
        account.signing_key, account.fingerprint)
      and exists (
        select 1 from public.libsignal_receive_attestations attestation
        where attestation.user_id = device.user_id and attestation.device_id = device.device_id
          and attestation.device_number = device.libsignal_device_number
          and attestation.proof->>'userId' = device.user_id::text
          and attestation.proof->>'deviceId' = device.device_id
          and attestation.proof->>'deviceNumber' = attestation.device_number::text
          and attestation.proof->>'registrationId' = attestation.registration_id::text
          and attestation.proof->>'devicePublicKey' = device.device_public_key
          and attestation.proof->>'deviceSigningKey' = device.device_signing_key
          and attestation.proof->>'deviceAuthorizationSignature' = device.device_authorization_signature
          and attestation.proof->>'accountIdentityKey' = account.identity_key
          and attestation.proof->>'accountSigningKey' = account.signing_key
          and attestation.proof->>'accountFingerprint' = account.fingerprint
          and attestation.proof->>'accountBindingSignature' = account.identity_binding_signature
          and attestation.proof->>'accountBindingVersion' = account.identity_binding_version::text
          and public.aegis_verify_ed25519(device.device_signing_key, attestation.proof->>'signature',
            convert_to(public.libsignal_bundle_binding_payload(attestation.user_id, attestation.device_id,
              attestation.device_number, attestation.registration_id, attestation.proof->>'publicBundle'), 'UTF8'))
      )), false) as is_routable
  from public.user_devices device
  left join lateral (
    select key.* from public.user_public_keys key
    where key.user_id = device.user_id and key.is_active = true
    order by key.created_at desc limit 1
  ) account on true
  where device.user_id = p_user_id and device.revoked_at is null
  order by device.device_id;
$function$;
revoke all on function public.get_sesame_device_list(uuid) from public, anon;
grant execute on function public.get_sesame_device_list(uuid) to authenticated, service_role;

-- L'arrivée d'une preuve change la route, pas la consommation d'une préclé.
create trigger bump_aegis_libsignal_attestation_route
after insert or update or delete on public.libsignal_receive_attestations
for each row execute function public.trg_bump_aegis_signature_route();

create or replace function public.trg_bump_aegis_device_route()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $function$
begin
  if tg_op <> 'UPDATE' or (
    old.device_id, old.device_public_key, old.device_signing_key, old.device_authorization_signature,
    old.is_active, old.approval_status, old.revoked_at, old.stale_at, old.crypto_invalid_at,
    old.binding_status, old.account_bound_at, old.routing_status, old.libsignal_device_number
  ) is distinct from (
    new.device_id, new.device_public_key, new.device_signing_key, new.device_authorization_signature,
    new.is_active, new.approval_status, new.revoked_at, new.stale_at, new.crypto_invalid_at,
    new.binding_status, new.account_bound_at, new.routing_status, new.libsignal_device_number
  ) then
    perform public.bump_aegis_user_route_version(case when tg_op = 'DELETE' then old.user_id else new.user_id end);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;
revoke all on function public.trg_bump_aegis_device_route() from public, anon, authenticated;

-- Invalide les instantanés préparés avant le changement de critère global.
select public.bump_aegis_user_route_version(device.user_id)
from (select distinct user_id from public.user_devices) device;

commit;
