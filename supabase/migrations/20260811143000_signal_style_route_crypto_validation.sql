-- Signal-style server validation for Aegis device trust and signed prekeys.
--
-- The server now cryptographically validates the same public trust chain that
-- clients validate before X3DH/session creation:
--   account identity binding -> account-authorized device -> device-signed SPK.
-- Invalid historical rows are fail-closed without replacing any key material.

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

-- Defense in depth: the service-role finalizer independently validates the
-- authorization instead of trusting that the Edge Function already did so.
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
  v_same_binding boolean := false;
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
  if nullif(trim(coalesce(v_device.device_public_key, '')), '') is null
     or nullif(trim(coalesce(v_device.device_signing_key, '')), '') is null then
    return jsonb_build_object('ok',false,'code','DEVICE_KEYS_INCOMPLETE');
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

  v_same_binding := v_device.binding_status = 'bound'
    and v_device.account_bound_at is not null
    and v_device.device_authorization_signature is not distinct from trim(p_device_authorization_signature);

  update public.user_devices
  set device_authorization_signature = trim(p_device_authorization_signature),
      binding_status = 'bound',
      account_bound_at = case
        when v_same_binding then coalesce(account_bound_at, v_now)
        else v_now
      end,
      crypto_invalid_at = null,
      crypto_invalid_reason = null,
      routing_status = case
        when v_same_binding and v_device.routing_status = 'ready' then 'ready'
        else 'repairing'
      end,
      routing_error = case
        when v_same_binding and v_device.routing_status = 'ready' then null
        else 'SIGNED_PREKEY_VALIDATION_PENDING'
      end,
      routing_checked_at = v_now,
      updated_at = v_now
  where id = v_device.id;

  return jsonb_build_object(
    'ok',true,
    'code','DEVICE_ACCOUNT_BOUND',
    'device_id',trim(p_device_id),
    'existing',v_same_binding
  );
end;
$$;

revoke all on function public.finalize_device_account_binding(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.finalize_device_account_binding(uuid,text,text)
  to service_role;

-- Signal's key endpoint validates the signed prekey before accepting it. Do the
-- same here: the device Ed25519 signing key must sign the raw X25519 SPK bytes.
create or replace function public.publish_device_signed_prekey(
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
  v_existing public.device_signed_prekeys%rowtype;
  v_device public.user_devices%rowtype;
  v_account public.user_public_keys%rowtype;
  v_now timestamptz := now();
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

  select * into v_existing
  from public.device_signed_prekeys
  where user_id = v_uid and device_id = v_device_id and spk_id = p_spk_id
  for update;
  if found and (
    v_existing.public_key is distinct from p_public_key
    or v_existing.signature is distinct from p_signature
  ) then
    return jsonb_build_object('ok', false, 'code', 'SPK_ID_CONFLICT');
  end if;

  update public.device_signed_prekeys
  set is_active = false,
      is_last_resort = false
  where user_id = v_uid
    and device_id = v_device_id
    and spk_id <> p_spk_id
    and (is_active = true or is_last_resort = true);

  insert into public.device_signed_prekeys (
    user_id, device_id, spk_id, public_key, signature,
    is_active, is_last_resort, created_at, expires_at
  ) values (
    v_uid, v_device_id, p_spk_id, p_public_key, p_signature,
    true, false, v_now, v_now + interval '30 days'
  )
  on conflict (user_id, device_id, spk_id) do update
  set is_active = true,
      is_last_resort = false,
      expires_at = greatest(public.device_signed_prekeys.expires_at, v_now + interval '30 days');

  update public.user_devices
  set routing_status = 'ready',
      routing_error = null,
      routing_checked_at = v_now,
      crypto_invalid_at = null,
      crypto_invalid_reason = null,
      updated_at = v_now
  where id = v_device.id;

  return jsonb_build_object(
    'ok', true,
    'code', 'SIGNED_PREKEY_PUBLISHED',
    'spk_id', p_spk_id
  );
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

-- OPKs may be replenished only by a device whose complete server route is
-- cryptographically valid. Claims already go through get_sesame_device_list.
create or replace function public.publish_device_one_time_prekeys(
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
  v_count integer;
  v_distinct integer;
  v_conflicts integer;
  v_existing integer;
  v_capacity integer;
  v_accepted integer[];
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if jsonb_typeof(p_prekeys) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ONE_TIME_PREKEY_BATCH');
  end if;

  select count(*), count(distinct item.opk_id)
    into v_count, v_distinct
  from jsonb_to_recordset(p_prekeys) as item(opk_id integer, public_key text);
  if v_count < 1 or v_count > 100 or v_count <> v_distinct then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ONE_TIME_PREKEY_BATCH');
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_prekeys) as item(opk_id integer, public_key text)
    where item.opk_id <= 0
       or length(trim(coalesce(item.public_key, ''))) < 40
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ONE_TIME_PREKEY');
  end if;
  if not exists (
    select 1
    from public.get_sesame_device_list(v_uid) device
    where device.device_id = v_device_id
      and device.is_routable = true
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_AUTHORIZED');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || v_device_id, 1));

  select count(*) into v_existing
  from public.device_one_time_prekeys existing
  where existing.user_id = v_uid
    and existing.device_id = v_device_id;
  v_capacity := greatest(0, 100 - v_existing);

  select count(*) into v_conflicts
  from jsonb_to_recordset(p_prekeys) as item(opk_id integer, public_key text)
  join public.device_one_time_prekeys existing
    on existing.user_id = v_uid
   and existing.device_id = v_device_id
   and existing.opk_id = item.opk_id
  where existing.public_key is distinct from item.public_key;
  if v_conflicts > 0 then
    return jsonb_build_object('ok', false, 'code', 'OPK_ID_CONFLICT');
  end if;

  with incoming as (
    select item.opk_id, item.public_key
    from jsonb_to_recordset(p_prekeys) as item(opk_id integer, public_key text)
  ), same_existing as (
    select incoming.opk_id
    from incoming
    join public.device_one_time_prekeys existing
      on existing.user_id = v_uid
     and existing.device_id = v_device_id
     and existing.opk_id = incoming.opk_id
     and existing.public_key = incoming.public_key
  ), candidates as (
    select incoming.opk_id, incoming.public_key
    from incoming
    left join public.device_one_time_prekeys existing
      on existing.user_id = v_uid
     and existing.device_id = incoming.opk_id::text
    where false
  ), new_candidates as (
    select incoming.opk_id, incoming.public_key
    from incoming
    left join public.device_one_time_prekeys existing
      on existing.user_id = v_uid
     and existing.device_id = v_device_id
     and existing.opk_id = incoming.opk_id
    where existing.id is null
    order by incoming.opk_id
    limit v_capacity
  ), inserted as (
    insert into public.device_one_time_prekeys (user_id, device_id, opk_id, public_key)
    select v_uid, v_device_id, new_candidates.opk_id, new_candidates.public_key
    from new_candidates
    on conflict (user_id, device_id, opk_id) do nothing
    returning opk_id
  ), accepted as (
    select opk_id from same_existing
    union
    select opk_id from inserted
  )
  select array_agg(opk_id order by opk_id)
    into v_accepted
  from accepted;

  select count(*) into v_existing
  from public.device_one_time_prekeys existing
  where existing.user_id = v_uid
    and existing.device_id = v_device_id;

  return jsonb_build_object(
    'ok', true,
    'code', 'ONE_TIME_PREKEYS_PUBLISHED',
    'accepted_ids', to_jsonb(coalesce(v_accepted, array[]::integer[])),
    'inventory_count', v_existing
  );
end;
$$;

revoke all on function public.publish_device_one_time_prekeys(text,jsonb)
  from public, anon;
grant execute on function public.publish_device_one_time_prekeys(text,jsonb)
  to authenticated, service_role;

-- One-time integrity sweep for historical states. No keys/signatures are
-- rewritten: invalid trust is only quarantined so the normal controlled
-- re-authorization/re-enrollment flow can repair it.
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
