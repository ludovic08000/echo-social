begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Une preuve valide pour les MÊMES clés reste valide après republication de
-- leur liaison : vérifier les signatures, jamais comparer leur texte.
-- L'autorisation actuelle, les révocations et la preuve Libsignal restent exigées.
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
          and attestation.proof->>'accountIdentityKey' = account.identity_key
          and attestation.proof->>'accountSigningKey' = account.signing_key
          and attestation.proof->>'accountFingerprint' = account.fingerprint
          and attestation.proof->>'accountBindingVersion' = account.identity_binding_version::text
          and public.aegis_verify_account_binding(account.identity_key, account.signing_key,
            account.fingerprint, attestation.proof->>'accountBindingSignature', account.identity_binding_version)
          and public.aegis_verify_device_authorization(device.user_id, device.device_id,
            device.device_public_key, device.device_signing_key,
            attestation.proof->>'deviceAuthorizationSignature', account.signing_key, account.fingerprint)
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

-- Invalider seulement les instantanés de routage ; aucune clé/copie n'est modifiée.
select public.bump_aegis_user_route_version(device.user_id)
from (select distinct user_id from public.user_devices) device;
commit;
