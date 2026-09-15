begin;

-- Aegis route readiness is backed exclusively by a sealed Libsignal store on
-- the device and a matching public Libsignal bundle on the server. The old
-- custom Signed PreKey tables are not part of this decision.
create or replace function public.mark_current_device_route_ready(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
    and device.libsignal_device_number between 1 and 127
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
      from public.device_libsignal_prekey_bundles bundle
      where bundle.user_id = v_uid
        and bundle.device_id = v_device_id
        and bundle.device_number = device.libsignal_device_number
        and length(bundle.public_bundle) between 100 and 262144
    );

  if not found then
    return jsonb_build_object('ok', false, 'code', 'LIBSIGNAL_BUNDLE_REQUIRED');
  end if;
  return jsonb_build_object('ok', true, 'code', 'DEVICE_ROUTE_READY');
end;
$$;

revoke all on function public.mark_current_device_route_ready(text) from public, anon;
grant execute on function public.mark_current_device_route_ready(text)
  to authenticated, service_role;

notify pgrst, 'reload schema';

commit;
