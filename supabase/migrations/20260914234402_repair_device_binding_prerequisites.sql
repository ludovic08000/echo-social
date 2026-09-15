begin;

-- Préserver les données de l'ancien registre tout en autorisant l'inscription
-- canonique, qui ne renseigne plus cet ancien fingerprint.
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public'
      and table_name='user_devices' and column_name='fingerprint') then
    alter table public.user_devices alter column fingerprint drop not null;
  end if;
end $$;

-- Même prérequis que la reconstruction : aucune approbation implicite.
alter table public.user_devices
  add column if not exists binding_status text not null default 'pending',
  add column if not exists account_bound_at timestamptz,
  add column if not exists possession_verified_at timestamptz;

create or replace function public.finalize_device_account_binding(
  p_user_id uuid,
  p_device_id text,
  p_device_authorization_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_device public.user_devices%rowtype;
  v_account public.user_public_keys%rowtype;
  v_existing_valid_binding boolean := false;
begin
  if p_user_id is null
     or trim(coalesce(p_device_id,'')) !~ '^dev_[a-f0-9]{32}$'
     or length(trim(coalesce(p_device_authorization_signature,''))) < 80 then
    return jsonb_build_object('ok',false,'code','INVALID_DEVICE_BINDING_INPUT');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));

  select * into v_device
  from public.user_devices d
  where d.user_id = p_user_id and d.device_id = trim(p_device_id)
  for update;
  if not found then
    return jsonb_build_object('ok',false,'code','DEVICE_NOT_FOUND');
  end if;
  if v_device.approval_status <> 'approved'
     or v_device.is_active <> true
     or v_device.revoked_at is not null then
    return jsonb_build_object('ok',false,'code','DEVICE_NOT_APPROVED');
  end if;
  if v_device.possession_verified_at is null then
    return jsonb_build_object('ok',false,'code','DEVICE_POSSESSION_NOT_VERIFIED');
  end if;

  select * into v_account
  from public.user_public_keys k
  where k.user_id = p_user_id and k.is_active = true
  order by k.created_at desc
  limit 1
  for update;
  if not found then
    return jsonb_build_object('ok',false,'code','ACCOUNT_IDENTITY_NOT_FOUND');
  end if;

  if not public.aegis_verify_account_binding(
    v_account.identity_key,
    v_account.signing_key,
    v_account.fingerprint,
    v_account.identity_binding_signature,
    v_account.identity_binding_version
  ) then
    update public.user_devices
    set crypto_invalid_at = coalesce(crypto_invalid_at, v_now),
        crypto_invalid_reason = 'ACCOUNT_BINDING_SIGNATURE_INVALID',
        routing_status = 'unavailable',
        routing_error = 'ACCOUNT_BINDING_SIGNATURE_INVALID',
        routing_checked_at = v_now,
        updated_at = v_now
    where id = v_device.id;
    return jsonb_build_object('ok',false,'code','ACCOUNT_BINDING_SIGNATURE_INVALID');
  end if;

  if not public.aegis_verify_device_authorization(
    p_user_id,
    trim(p_device_id),
    v_device.device_public_key,
    v_device.device_signing_key,
    trim(p_device_authorization_signature),
    v_account.signing_key,
    v_account.fingerprint
  ) then
    update public.user_devices
    set crypto_invalid_at = coalesce(crypto_invalid_at, v_now),
        crypto_invalid_reason = 'DEVICE_AUTHORIZATION_SIGNATURE_INVALID',
        routing_status = 'unavailable',
        routing_error = 'DEVICE_AUTHORIZATION_SIGNATURE_INVALID',
        routing_checked_at = v_now,
        updated_at = v_now
    where id = v_device.id;
    return jsonb_build_object('ok',false,'code','DEVICE_AUTHORIZATION_SIGNATURE_INVALID');
  end if;

  v_existing_valid_binding := v_device.binding_status = 'bound'
    and v_device.account_bound_at is not null
    and v_device.device_authorization_signature is not distinct from trim(p_device_authorization_signature);

  if v_existing_valid_binding then
    update public.user_devices
    set crypto_invalid_at = null,
        crypto_invalid_reason = null,
        routing_checked_at = v_now,
        updated_at = v_now
    where id = v_device.id;
    return jsonb_build_object(
      'ok',true,
      'code','DEVICE_ACCOUNT_BOUND',
      'device_id',trim(p_device_id),
      'existing',true
    );
  end if;

  -- La liaison valide autorise la synchronisation, jamais READY sans préclés.
  update public.user_devices
  set binding_status = 'bound',
      account_bound_at = v_now,
      device_authorization_signature = trim(p_device_authorization_signature),
      lifecycle_status = 'syncing',
      routing_status = 'repairing',
      routing_error = 'DEVICE_SYNC_REQUIRED',
      routing_checked_at = v_now,
      crypto_invalid_at = null,
      crypto_invalid_reason = null,
      updated_at = v_now
  where id = v_device.id;
  return jsonb_build_object('ok',true,'code','DEVICE_ACCOUNT_BOUND',
    'device_id',trim(p_device_id),'existing',false);
end;
$$;

revoke all on function public.finalize_device_account_binding(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.finalize_device_account_binding(uuid,text,text)
  to service_role;

drop function if exists public.finalize_device_account_binding_pre_signal_validation(uuid,text,text);

commit;
