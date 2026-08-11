-- Signal-style server validation for Aegis device trust and signed prekeys.
--
-- The server validates the same public trust chain that clients validate before
-- X3DH/session creation:
--   account identity binding -> account-authorized device -> device-signed SPK.
-- Existing key material is never rewritten by the integrity sweep; invalid
-- historical states are only quarantined and made non-routable.

begin;

create or replace function public.aegis_decode_base64(p_value text)
returns bytea
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $$
declare
  v_value text := translate(trim(coalesce(p_value, '')), '-_', '+/');
begin
  if v_value = '' then
    return null;
  end if;
  v_value := v_value || repeat('=', (4 - (length(v_value) % 4)) % 4);
  return decode(v_value, 'base64');
exception when others then
  return null;
end;
$$;

create or replace function public.aegis_verify_ed25519(
  p_public_key text,
  p_signature text,
  p_message bytea
)
returns boolean
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $$
declare
  v_key bytea := public.aegis_decode_base64(p_public_key);
  v_signature bytea := public.aegis_decode_base64(p_signature);
begin
  if octet_length(v_key) is distinct from 32
     or octet_length(v_signature) is distinct from 64
     or p_message is null then
    return false;
  end if;
  return pgsodium.crypto_sign_verify_detached(v_signature, p_message, v_key);
exception when others then
  return false;
end;
$$;

create or replace function public.aegis_account_binding_payload(
  p_identity_key text,
  p_signing_key text
)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select '{"protocol":"forsure-aegis-account-identity","version":1,"identityKey":'
    || to_json(p_identity_key)::text
    || ',"signingKey":' || to_json(p_signing_key)::text || '}';
$$;

create or replace function public.aegis_account_fingerprint(p_payload text)
returns text
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $$
declare
  v_hex text;
begin
  if p_payload is null then
    return null;
  end if;
  v_hex := upper(encode(
    substring(extensions.digest(convert_to(p_payload, 'UTF8'), 'sha256') from 1 for 20),
    'hex'
  ));
  return substr(v_hex, 1, 8) || ' '
    || substr(v_hex, 9, 8) || ' '
    || substr(v_hex, 17, 8) || ' '
    || substr(v_hex, 25, 8) || ' '
    || substr(v_hex, 33, 8);
end;
$$;

create or replace function public.aegis_verify_account_binding(
  p_identity_key text,
  p_signing_key text,
  p_fingerprint text,
  p_binding_signature text,
  p_binding_version integer
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_payload text;
begin
  if p_binding_version is distinct from 1
     or nullif(trim(coalesce(p_identity_key, '')), '') is null
     or nullif(trim(coalesce(p_signing_key, '')), '') is null
     or nullif(trim(coalesce(p_fingerprint, '')), '') is null
     or nullif(trim(coalesce(p_binding_signature, '')), '') is null then
    return false;
  end if;

  v_payload := public.aegis_account_binding_payload(p_identity_key, p_signing_key);
  if public.aegis_account_fingerprint(v_payload) is distinct from p_fingerprint then
    return false;
  end if;

  return public.aegis_verify_ed25519(
    p_signing_key,
    p_binding_signature,
    convert_to(v_payload, 'UTF8')
  );
exception when others then
  return false;
end;
$$;

create or replace function public.aegis_device_authorization_payload(
  p_user_id uuid,
  p_device_id text,
  p_account_fingerprint text,
  p_device_public_key text,
  p_device_signing_key text
)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select '{"protocol":"forsure-aegis-device-authorization","userId":'
    || to_json(p_user_id::text)::text
    || ',"deviceId":' || to_json(p_device_id)::text
    || ',"accountFingerprint":' || to_json(p_account_fingerprint)::text
    || ',"devicePublicKey":' || to_json(p_device_public_key)::text
    || ',"deviceSigningKey":' || to_json(p_device_signing_key)::text || '}';
$$;

create or replace function public.aegis_verify_device_authorization(
  p_user_id uuid,
  p_device_id text,
  p_device_public_key text,
  p_device_signing_key text,
  p_device_authorization_signature text,
  p_account_signing_key text,
  p_account_fingerprint text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_payload text;
begin
  if p_user_id is null
     or trim(coalesce(p_device_id, '')) !~ '^dev_[a-f0-9]{32}$'
     or nullif(trim(coalesce(p_device_public_key, '')), '') is null
     or nullif(trim(coalesce(p_device_signing_key, '')), '') is null
     or nullif(trim(coalesce(p_device_authorization_signature, '')), '') is null
     or nullif(trim(coalesce(p_account_signing_key, '')), '') is null
     or nullif(trim(coalesce(p_account_fingerprint, '')), '') is null then
    return false;
  end if;

  v_payload := public.aegis_device_authorization_payload(
    p_user_id,
    trim(p_device_id),
    p_account_fingerprint,
    p_device_public_key,
    p_device_signing_key
  );

  return public.aegis_verify_ed25519(
    p_account_signing_key,
    p_device_authorization_signature,
    convert_to(v_payload, 'UTF8')
  );
exception when others then
  return false;
end;
$$;

create or replace function public.aegis_verify_signed_prekey(
  p_device_signing_key text,
  p_spk_public_key text,
  p_spk_signature text
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_spk bytea := public.aegis_decode_base64(p_spk_public_key);
begin
  if octet_length(v_spk) is distinct from 32 then
    return false;
  end if;
  return public.aegis_verify_ed25519(
    p_device_signing_key,
    p_spk_signature,
    v_spk
  );
exception when others then
  return false;
end;
$$;

revoke all on function public.aegis_decode_base64(text) from public, anon, authenticated;
revoke all on function public.aegis_verify_ed25519(text,text,bytea) from public, anon, authenticated;
revoke all on function public.aegis_account_binding_payload(text,text) from public, anon, authenticated;
revoke all on function public.aegis_account_fingerprint(text) from public, anon, authenticated;
revoke all on function public.aegis_verify_account_binding(text,text,text,text,integer) from public, anon, authenticated;
revoke all on function public.aegis_device_authorization_payload(uuid,text,text,text,text) from public, anon, authenticated;
revoke all on function public.aegis_verify_device_authorization(uuid,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.aegis_verify_signed_prekey(text,text,text) from public, anon, authenticated;

-- Keep the already-tested state transitions, but put a cryptographic guard in
-- front of the service-role finalizer.
alter function public.finalize_device_account_binding(uuid,text,text)
  rename to finalize_device_account_binding_pre_signal_validation;
revoke all on function public.finalize_device_account_binding_pre_signal_validation(uuid,text,text)
  from public, anon, authenticated, service_role;

create function public.finalize_device_account_binding(
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
  v_result jsonb;
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

  v_result := public.finalize_device_account_binding_pre_signal_validation(
    p_user_id,
    trim(p_device_id),
    trim(p_device_authorization_signature)
  );

  if coalesce((v_result ->> 'ok')::boolean, false) then
    update public.user_devices
    set crypto_invalid_at = null,
        crypto_invalid_reason = null,
        updated_at = v_now
    where id = v_device.id;
  end if;
  return v_result;
end;
$$;

revoke all on function public.finalize_device_account_binding(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.finalize_device_account_binding(uuid,text,text)
  to service_role;

-- Signal validates a signed prekey before accepting it. Preserve the existing
-- publish transaction behind a guard that verifies account trust, device
-- authorization and the Ed25519 signature over the raw X25519 SPK bytes.
alter function public.publish_device_signed_prekey(text,integer,text,text)
  rename to publish_device_signed_prekey_pre_signal_validation;
revoke all on function public.publish_device_signed_prekey_pre_signal_validation(text,integer,text,text)
  from public, anon, authenticated, service_role;

create function public.publish_device_signed_prekey(
  p_device_id text,
  p_spk_id integer,
  p_public_key text,
  p_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_device public.user_devices%rowtype;
  v_account public.user_public_keys%rowtype;
  v_now timestamptz := now();
  v_result jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if length(v_device_id) < 8 or p_spk_id <= 0
     or length(trim(coalesce(p_public_key, ''))) < 40
     or length(trim(coalesce(p_signature, ''))) < 80 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SIGNED_PREKEY');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || v_device_id, 0));

  select * into v_device
  from public.user_devices d
  where d.user_id = v_uid and d.device_id = v_device_id
  for update;
  if not found
     or v_device.is_active is not true
     or v_device.revoked_at is not null
     or coalesce(v_device.approval_status, 'approved') <> 'approved'
     or v_device.binding_status <> 'bound'
     or v_device.account_bound_at is null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_AUTHORIZED');
  end if;

  select * into v_account
  from public.user_public_keys k
  where k.user_id = v_uid and k.is_active = true
  order by k.created_at desc
  limit 1
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ACCOUNT_IDENTITY_NOT_FOUND');
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
    return jsonb_build_object('ok', false, 'code', 'ACCOUNT_BINDING_SIGNATURE_INVALID');
  end if;

  if not public.aegis_verify_device_authorization(
    v_uid,
    v_device_id,
    v_device.device_public_key,
    v_device.device_signing_key,
    v_device.device_authorization_signature,
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
    return jsonb_build_object('ok', false, 'code', 'DEVICE_AUTHORIZATION_SIGNATURE_INVALID');
  end if;

  if not public.aegis_verify_signed_prekey(
    v_device.device_signing_key,
    p_public_key,
    p_signature
  ) then
    update public.user_devices
    set routing_status = 'repairing',
        routing_error = 'DEVICE_SPK_SIGNATURE_INVALID',
        routing_checked_at = v_now,
        updated_at = v_now
    where id = v_device.id;
    return jsonb_build_object('ok', false, 'code', 'DEVICE_SPK_SIGNATURE_INVALID');
  end if;

  v_result := public.publish_device_signed_prekey_pre_signal_validation(
    v_device_id,
    p_spk_id,
    p_public_key,
    p_signature
  );

  if coalesce((v_result ->> 'ok')::boolean, false) then
    update public.user_devices
    set crypto_invalid_at = null,
        crypto_invalid_reason = null,
        updated_at = v_now
    where id = v_device.id;
  end if;
  return v_result;
end;
$$;

revoke all on function public.publish_device_signed_prekey(text,integer,text,text)
  from public, anon;
grant execute on function public.publish_device_signed_prekey(text,integer,text,text)
  to authenticated, service_role;

-- Route resolution is fail-closed on the actual cryptographic trust chain, not
-- merely on the presence of signature columns/status flags.
create or replace function public.get_sesame_device_list(p_user_id uuid)
returns table(
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
  is_routable boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    d.device_id,
    d.device_public_key,
    d.device_signing_key,
    d.device_authorization_signature,
    d.last_seen_at,
    k.identity_key as account_identity_key,
    k.signing_key as account_signing_key,
    k.fingerprint as account_fingerprint,
    k.identity_binding_signature as account_binding_signature,
    k.identity_binding_version as account_binding_version,
    (
      d.approval_status = 'approved'
      and d.is_active = true
      and d.revoked_at is null
      and d.crypto_invalid_at is null
      and d.binding_status = 'bound'
      and d.account_bound_at is not null
      and d.routing_status = 'ready'
      and nullif(trim(d.device_public_key), '') is not null
      and nullif(trim(d.device_signing_key), '') is not null
      and nullif(trim(d.device_authorization_signature), '') is not null
      and k.user_id is not null
      and k.is_active = true
      and public.aegis_verify_account_binding(
        k.identity_key,
        k.signing_key,
        k.fingerprint,
        k.identity_binding_signature,
        k.identity_binding_version
      )
      and public.aegis_verify_device_authorization(
        d.user_id,
        d.device_id,
        d.device_public_key,
        d.device_signing_key,
        d.device_authorization_signature,
        k.signing_key,
        k.fingerprint
      )
      and exists (
        select 1
        from public.device_signed_prekeys spk
        where spk.user_id = d.user_id
          and spk.device_id = d.device_id
          and spk.is_active = true
          and spk.expires_at > now()
          and public.aegis_verify_signed_prekey(
            d.device_signing_key,
            spk.public_key,
            spk.signature
          )
      )
    ) as is_routable
  from public.user_devices d
  left join lateral (
    select uk.*
    from public.user_public_keys uk
    where uk.user_id = d.user_id and uk.is_active = true
    order by uk.created_at desc
    limit 1
  ) k on true
  where d.user_id = p_user_id
    and d.revoked_at is null
  order by d.device_id;
$$;

revoke all on function public.get_sesame_device_list(uuid) from public, anon;
grant execute on function public.get_sesame_device_list(uuid)
  to authenticated, service_role;

-- Keep the atomic inventory implementation, but put the same cryptographic
-- route guard in front of it.
alter function public.publish_device_one_time_prekeys(text,jsonb)
  rename to publish_device_one_time_prekeys_pre_signal_validation;
revoke all on function public.publish_device_one_time_prekeys_pre_signal_validation(text,jsonb)
  from public, anon, authenticated, service_role;

create function public.publish_device_one_time_prekeys(
  p_device_id text,
  p_prekeys jsonb
)
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
  if not exists (
    select 1
    from public.get_sesame_device_list(v_uid) device
    where device.device_id = v_device_id
      and device.is_routable = true
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_AUTHORIZED');
  end if;

  return public.publish_device_one_time_prekeys_pre_signal_validation(
    v_device_id,
    p_prekeys
  );
end;
$$;

revoke all on function public.publish_device_one_time_prekeys(text,jsonb)
  from public, anon;
grant execute on function public.publish_device_one_time_prekeys(text,jsonb)
  to authenticated, service_role;

-- One-time integrity sweep for historical states. This is intentionally a
-- quarantine only: no public key or signature is repaired/forged server-side.
with current_account as (
  select distinct on (k.user_id)
    k.user_id,
    k.identity_key,
    k.signing_key,
    k.fingerprint,
    k.identity_binding_signature,
    k.identity_binding_version
  from public.user_public_keys k
  where k.is_active = true
  order by k.user_id, k.created_at desc
)
update public.user_devices d
set crypto_invalid_at = coalesce(d.crypto_invalid_at, now()),
    crypto_invalid_reason = case
      when not public.aegis_verify_account_binding(
        a.identity_key,
        a.signing_key,
        a.fingerprint,
        a.identity_binding_signature,
        a.identity_binding_version
      ) then 'ACCOUNT_BINDING_SIGNATURE_INVALID'
      else 'DEVICE_AUTHORIZATION_SIGNATURE_INVALID'
    end,
    routing_status = 'unavailable',
    routing_error = case
      when not public.aegis_verify_account_binding(
        a.identity_key,
        a.signing_key,
        a.fingerprint,
        a.identity_binding_signature,
        a.identity_binding_version
      ) then 'ACCOUNT_BINDING_SIGNATURE_INVALID'
      else 'DEVICE_AUTHORIZATION_SIGNATURE_INVALID'
    end,
    routing_checked_at = now(),
    updated_at = now()
from current_account a
where d.user_id = a.user_id
  and d.revoked_at is null
  and d.approval_status = 'approved'
  and d.is_active = true
  and d.binding_status = 'bound'
  and (
    not public.aegis_verify_account_binding(
      a.identity_key,
      a.signing_key,
      a.fingerprint,
      a.identity_binding_signature,
      a.identity_binding_version
    )
    or not public.aegis_verify_device_authorization(
      d.user_id,
      d.device_id,
      d.device_public_key,
      d.device_signing_key,
      d.device_authorization_signature,
      a.signing_key,
      a.fingerprint
    )
  );

update public.user_devices d
set routing_status = 'repairing',
    routing_error = case
      when exists (
        select 1
        from public.device_signed_prekeys spk
        where spk.user_id = d.user_id
          and spk.device_id = d.device_id
          and spk.is_active = true
          and spk.expires_at > now()
      ) then 'DEVICE_SPK_SIGNATURE_INVALID'
      else 'SIGNED_PREKEY_VALIDATION_PENDING'
    end,
    routing_checked_at = now(),
    updated_at = now()
where d.revoked_at is null
  and d.routing_status = 'ready'
  and d.crypto_invalid_at is null
  and not exists (
    select 1
    from public.device_signed_prekeys spk
    where spk.user_id = d.user_id
      and spk.device_id = d.device_id
      and spk.is_active = true
      and spk.expires_at > now()
      and public.aegis_verify_signed_prekey(
        d.device_signing_key,
        spk.public_key,
        spk.signature
      )
  );

notify pgrst, 'reload schema';

commit;
