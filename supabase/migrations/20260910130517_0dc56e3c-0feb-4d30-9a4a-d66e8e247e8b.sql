-- Invariant corrigé : publier un bundle libsignal ne prouve ni le binding, ni la
-- préclé signée, ni la synchronisation. Cette RPC ne doit donc JAMAIS écrire
-- routing_status ni lifecycle_status.
CREATE OR REPLACE FUNCTION public.publish_libsignal_prekey_bundle(
  p_device_id text,
  p_device_number integer,
  p_registration_id bigint,
  p_prekey_id bigint,
  p_signed_prekey_id bigint,
  p_kyber_prekey_id bigint,
  p_public_bundle text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_device text := trim(coalesce(p_device_id,''));
begin
  if v_uid is null then return jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); end if;
  if p_device_number not between 1 and 127 or length(p_public_bundle) not between 100 and 262144 then
    return jsonb_build_object('ok',false,'code','INVALID_LIBSIGNAL_BUNDLE');
  end if;
  if not exists(
    select 1 from public.user_devices d
    where d.user_id = v_uid
      and d.device_id = v_device
      and d.libsignal_device_number = p_device_number
      and d.is_active = true
      and d.revoked_at is null
      and d.approval_status = 'approved'
      and d.binding_status = 'bound'
      and d.account_bound_at is not null
  ) then
    return jsonb_build_object('ok',false,'code','DEVICE_NOT_AUTHORIZED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||v_device, 7));
  insert into public.device_libsignal_prekey_bundles(
    user_id, device_id, device_number, registration_id, prekey_id,
    signed_prekey_id, kyber_prekey_id, public_bundle)
  values(v_uid, v_device, p_device_number, p_registration_id, p_prekey_id,
         p_signed_prekey_id, p_kyber_prekey_id, p_public_bundle)
  on conflict(user_id,device_id,prekey_id) do update set public_bundle = excluded.public_bundle
  where public.device_libsignal_prekey_bundles.public_bundle = excluded.public_bundle;
  return jsonb_build_object('ok',true,'code','LIBSIGNAL_BUNDLE_PUBLISHED');
end $function$;

REVOKE ALL ON FUNCTION public.publish_libsignal_prekey_bundle(text,integer,bigint,bigint,bigint,bigint,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.publish_libsignal_prekey_bundle(text,integer,bigint,bigint,bigint,bigint,text) TO authenticated, service_role;

-- Invariant corrigé : la route n'est prête qu'avec binding bound + SPK active
-- vérifiée + au moins un bundle libsignal publié pour CE device.
CREATE OR REPLACE FUNCTION public.mark_current_device_route_ready(p_device_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  update public.user_devices device
  set routing_status = 'ready',
      routing_error = null,
      routing_checked_at = now(),
      crypto_invalid_at = null,
      crypto_invalid_reason = null,
      updated_at = now()
  where device.user_id = v_uid
    and device.device_id = v_device_id
    and device.is_active = true
    and device.revoked_at is null
    and device.stale_at is null
    and device.approval_status = 'approved'
    and device.binding_status = 'bound'
    and device.account_bound_at is not null
    and nullif(trim(device.device_public_key), '') is not null
    and nullif(trim(device.device_signing_key), '') is not null
    and nullif(trim(device.device_authorization_signature), '') is not null
    and exists (
      select 1
      from public.user_public_keys account
      where account.user_id = v_uid
        and account.is_active = true
        and account.id = (
          select current_account.id
          from public.user_public_keys current_account
          where current_account.user_id = v_uid
            and current_account.is_active = true
          order by current_account.created_at desc
          limit 1
        )
        and public.aegis_verify_account_binding(
          account.identity_key,
          account.signing_key,
          account.fingerprint,
          account.identity_binding_signature,
          account.identity_binding_version
        )
        and public.aegis_verify_device_authorization(
          device.user_id,
          device.device_id,
          device.device_public_key,
          device.device_signing_key,
          device.device_authorization_signature,
          account.signing_key,
          account.fingerprint
        )
    )
    and exists (
      select 1
      from public.device_signed_prekeys spk
      where spk.user_id = v_uid
        and spk.device_id = v_device_id
        and spk.is_active = true
        and spk.expires_at > now()
        and public.aegis_verify_signed_prekey(
          device.device_signing_key,
          spk.public_key,
          spk.signature
        )
    )
    and exists (
      select 1
      from public.device_libsignal_prekey_bundles bundle
      where bundle.user_id = v_uid
        and bundle.device_id = v_device_id
        and bundle.device_number = device.libsignal_device_number
        and length(bundle.public_bundle) between 100 and 262144
    );

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ROUTE_INCOMPLETE');
  end if;
  return jsonb_build_object('ok', true, 'code', 'DEVICE_ROUTE_READY');
end;
$function$;

REVOKE ALL ON FUNCTION public.mark_current_device_route_ready(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.mark_current_device_route_ready(text) TO authenticated, service_role;

-- Diagnostic en lecture seule : détecte les appareils du demandeur bloqués en
-- route prête sans synchronisation terminée (repris automatiquement au prochain
-- démarrage par le contrôleur de cycle de vie).
CREATE OR REPLACE FUNCTION public.diagnose_device_lifecycle_drift()
RETURNS TABLE(device_id text, routing_status text, lifecycle_status text, updated_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  select d.device_id, d.routing_status, d.lifecycle_status, d.updated_at
  from public.user_devices d
  where d.user_id = auth.uid()
    and d.routing_status = 'ready'
    and coalesce(d.lifecycle_status, '') <> 'ready'
$function$;

REVOKE ALL ON FUNCTION public.diagnose_device_lifecycle_drift() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.diagnose_device_lifecycle_drift() TO authenticated, service_role;