begin;

create or replace function public.get_sesame_device_list(p_user_id uuid)
returns table (
  device_id text,
  device_public_key text,
  device_signing_key text,
  device_authorization_signature text,
  last_seen_at timestamptz,
  account_identity_key text,
  account_signing_key text,
  account_fingerprint text,
  account_binding_signature text,
  account_binding_version integer,
  is_routable boolean,
  revoked_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select
    device.device_id,
    device.device_public_key,
    device.device_signing_key,
    device.device_authorization_signature,
    device.last_seen_at,
    account.identity_key,
    account.signing_key,
    account.fingerprint,
    account.identity_binding_signature,
    account.identity_binding_version,
    (
      device.is_active = true
      and coalesce(device.approval_status, 'approved') = 'approved'
      and device.revoked_at is null
      and device.crypto_invalid_at is null
      and exists (
        select 1
        from public.device_signed_prekeys spk
        where spk.user_id = device.user_id
          and spk.device_id = device.device_id
          and spk.is_active = true
          and (spk.expires_at is null or spk.expires_at > now())
      )
    ) as is_routable,
    device.revoked_at
  from public.user_devices device
  join public.user_public_keys account
    on account.user_id = device.user_id
   and account.is_active = true
  where device.user_id = p_user_id
    and nullif(trim(device.device_public_key), '') is not null
    and nullif(trim(device.device_signing_key), '') is not null
    and nullif(trim(device.device_authorization_signature), '') is not null
    and nullif(trim(account.identity_key), '') is not null
    and nullif(trim(account.signing_key), '') is not null
    and nullif(trim(account.fingerprint), '') is not null
    and account.identity_binding_version = 1
    and nullif(trim(account.identity_binding_signature), '') is not null
  order by device.device_id;
$function$;

update public.user_devices device
set routing_status = case
      when exists (
        select 1
        from public.device_signed_prekeys spk
        where spk.user_id = device.user_id
          and spk.device_id = device.device_id
          and spk.is_active = true
          and (spk.expires_at is null or spk.expires_at > now())
      ) then 'ready'
      else 'repairing'
    end,
    routing_error = case
      when exists (
        select 1
        from public.device_signed_prekeys spk
        where spk.user_id = device.user_id
          and spk.device_id = device.device_id
          and spk.is_active = true
          and (spk.expires_at is null or spk.expires_at > now())
      ) then null
      else 'SIGNED_PREKEY_REQUIRED'
    end,
    routing_checked_at = now(),
    updated_at = now()
where device.revoked_at is null
  and device.crypto_invalid_at is null
  and coalesce(device.approval_status, 'approved') <> 'rejected';

notify pgrst, 'reload schema';

commit;
