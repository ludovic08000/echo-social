begin;

create extension if not exists pgcrypto;

-- The stable account identity is the only authority allowed to authorize a
-- physical device. Self-signed device rows are removed, not read in parallel.
alter table public.user_devices
  add column if not exists device_authorization_signature text;

-- The stage-2 transport reads the canonical account-authorized registry
-- directly. Remove the old projection rather than retaining a wrapper.
drop function if exists public.get_signed_device_list(uuid) cascade;

-- Remove callable objects that depend on the obsolete self-authorization
-- columns before dropping those columns. No CASCADE is used: an unknown
-- dependency must fail the migration rather than silently remove code.
drop function if exists public.get_sesame_device_list(uuid);
drop function if exists public.register_user_device_safe(uuid,text,text,text,text,text,text);
drop function if exists public.register_user_device_safe(uuid,text,text,text,text,text,text,text,text,integer);
drop function if exists public.register_user_device_safe(uuid,text,text,text,text,text,text,text,text,text,text,text,text);
drop function if exists public.mark_current_device_route_ready(text);
drop function if exists public.approve_user_device(text);
drop trigger if exists bump_aegis_device_route on public.user_devices;
drop function if exists public.trg_bump_aegis_device_route();

alter table public.user_devices
  drop constraint if exists user_devices_device_identity_version_check,
  drop column if exists device_identity_signature,
  drop column if exists device_identity_version;

-- Existing development rows are not grandfathered into the new authority
-- model. Opening the current client re-authorizes the installation.
update public.user_devices
set device_authorization_signature = null,
    routing_status = 'repairing',
    routing_error = 'ACCOUNT_AUTHORIZATION_REQUIRED',
    routing_checked_at = now()
where revoked_at is null;

create or replace function public.trg_bump_aegis_device_route()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  v_user_id := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  if tg_op <> 'UPDATE' or (
    old.device_id,
    old.device_public_key,
    old.device_signing_key,
    old.device_authorization_signature,
    old.is_active,
    old.approval_status,
    old.revoked_at,
    old.routing_status
  ) is distinct from (
    new.device_id,
    new.device_public_key,
    new.device_signing_key,
    new.device_authorization_signature,
    new.is_active,
    new.approval_status,
    new.revoked_at,
    new.routing_status
  ) then
    perform public.bump_aegis_user_route_version(v_user_id);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger bump_aegis_device_route
after insert or update or delete on public.user_devices
for each row execute function public.trg_bump_aegis_device_route();

create function public.get_sesame_device_list(p_user_id uuid)
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
security definer
stable
set search_path = public, pg_temp
as $$
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
      and coalesce(device.routing_status, 'repairing') <> 'unavailable'
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
$$;

revoke all on function public.get_sesame_device_list(uuid) from public, anon;
grant execute on function public.get_sesame_device_list(uuid) to authenticated;

create function public.register_user_device_safe(
  p_user_id uuid,
  p_device_id text,
  p_device_name text,
  p_device_public_key text,
  p_device_fingerprint text,
  p_platform text,
  p_user_agent text,
  p_device_signing_key text,
  p_device_authorization_signature text,
  p_account_identity_key text,
  p_account_signing_key text,
  p_account_fingerprint text,
  p_account_binding_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_existing_device public.user_devices%rowtype;
  v_existing_account public.user_public_keys%rowtype;
  v_now timestamptz := now();
begin
  if v_uid is null or p_user_id is distinct from v_uid then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if length(v_device_id) < 8
     or length(trim(coalesce(p_device_public_key, ''))) < 40
     or length(trim(coalesce(p_device_signing_key, ''))) < 40
     or length(trim(coalesce(p_device_authorization_signature, ''))) < 80
     or length(trim(coalesce(p_account_identity_key, ''))) < 40
     or length(trim(coalesce(p_account_signing_key, ''))) < 40
     or length(trim(coalesce(p_account_fingerprint, ''))) < 32
     or length(trim(coalesce(p_account_binding_signature, ''))) < 80 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_AUTHORIZATION');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  select * into v_existing_account
  from public.user_public_keys
  where user_id = v_uid
  for update;

  if found then
    if v_existing_account.identity_key is distinct from p_account_identity_key
       or v_existing_account.signing_key is distinct from p_account_signing_key
       or v_existing_account.fingerprint is distinct from p_account_fingerprint
       or v_existing_account.identity_binding_signature is distinct from p_account_binding_signature
       or v_existing_account.identity_binding_version is distinct from 1 then
      return jsonb_build_object('ok', false, 'code', 'ACCOUNT_IDENTITY_MISMATCH');
    end if;
    update public.user_public_keys
    set is_active = true,
        updated_at = v_now
    where user_id = v_uid;
  else
    insert into public.user_public_keys (
      user_id, identity_key, signing_key, fingerprint, kem_type,
      identity_binding_version, identity_binding_signature,
      is_active, created_at, updated_at
    ) values (
      v_uid, p_account_identity_key, p_account_signing_key,
      p_account_fingerprint, 'X25519', 1, p_account_binding_signature,
      true, v_now, v_now
    );
  end if;

  select * into v_existing_device
  from public.user_devices
  where user_id = v_uid and device_id = v_device_id
  for update;

  if found and (
    v_existing_device.revoked_at is not null
    or v_existing_device.approval_status = 'rejected'
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_REVOKED_OR_REJECTED');
  end if;
  if found and (
    v_existing_device.device_public_key is distinct from p_device_public_key
    or (
      v_existing_device.device_signing_key is not null
      and v_existing_device.device_signing_key is distinct from p_device_signing_key
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_IDENTITY_MISMATCH');
  end if;

  insert into public.user_devices (
    user_id, device_id, device_name, device_public_key,
    device_signing_key, device_authorization_signature,
    device_fingerprint, platform, user_agent, is_active, last_seen_at,
    approval_status, approval_requested_at, approved_at, approved_by,
    stale_at, routing_status, routing_error, routing_checked_at
  ) values (
    v_uid, v_device_id, p_device_name, p_device_public_key,
    p_device_signing_key, p_device_authorization_signature,
    p_device_fingerprint, p_platform, p_user_agent, true, v_now,
    'approved', v_now, v_now, v_uid,
    null, 'repairing', 'SIGNED_PREKEY_VALIDATION_PENDING', v_now
  )
  on conflict (user_id, device_id) do update
  set device_name = excluded.device_name,
      device_fingerprint = excluded.device_fingerprint,
      platform = excluded.platform,
      user_agent = excluded.user_agent,
      last_seen_at = v_now,
      updated_at = v_now,
      is_active = true,
      approval_status = 'approved',
      approved_at = coalesce(public.user_devices.approved_at, v_now),
      approved_by = coalesce(public.user_devices.approved_by, v_uid),
      stale_at = null,
      device_signing_key = excluded.device_signing_key,
      device_authorization_signature = excluded.device_authorization_signature,
      routing_status = case
        when exists (
          select 1 from public.device_signed_prekeys spk
          where spk.user_id = v_uid
            and spk.device_id = v_device_id
            and spk.is_active = true
            and spk.expires_at > v_now
        ) then 'ready' else 'repairing' end,
      routing_error = case
        when exists (
          select 1 from public.device_signed_prekeys spk
          where spk.user_id = v_uid
            and spk.device_id = v_device_id
            and spk.is_active = true
            and spk.expires_at > v_now
        ) then null else 'SIGNED_PREKEY_VALIDATION_PENDING' end,
      routing_checked_at = v_now
  where public.user_devices.revoked_at is null
    and coalesce(public.user_devices.approval_status, 'approved') <> 'rejected';

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_AUTHORIZED',
    'device_id', v_device_id
  );
end;
$$;

revoke all on function public.register_user_device_safe(
  uuid,text,text,text,text,text,text,text,text,text,text,text,text
) from public, anon;
grant execute on function public.register_user_device_safe(
  uuid,text,text,text,text,text,text,text,text,text,text,text,text
) to authenticated;

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
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if length(v_device_id) < 8 or p_spk_id <= 0
     or length(trim(coalesce(p_public_key, ''))) < 40
     or length(trim(coalesce(p_signature, ''))) < 80 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SIGNED_PREKEY');
  end if;
  if not exists (
    select 1 from public.user_devices device
    where device.user_id = v_uid
      and device.device_id = v_device_id
      and device.is_active = true
      and device.revoked_at is null
      and coalesce(device.approval_status, 'approved') = 'approved'
      and nullif(trim(device.device_authorization_signature), '') is not null
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_AUTHORIZED');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || v_device_id, 0));

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
    true, false, now(), now() + interval '30 days'
  )
  on conflict (user_id, device_id, spk_id) do update
  set is_active = true,
      is_last_resort = false,
      expires_at = greatest(public.device_signed_prekeys.expires_at, now() + interval '30 days');

  update public.user_devices
  set routing_status = 'ready',
      routing_error = null,
      routing_checked_at = now(),
      updated_at = now()
  where user_id = v_uid
    and device_id = v_device_id
    and nullif(trim(device_authorization_signature), '') is not null;

  return jsonb_build_object(
    'ok', true,
    'code', 'SIGNED_PREKEY_PUBLISHED',
    'spk_id', p_spk_id
  );
end;
$$;

revoke all on function public.publish_device_signed_prekey(text,integer,text,text) from public, anon;
grant execute on function public.publish_device_signed_prekey(text,integer,text,text) to authenticated;

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
    select 1 from public.user_devices device
    where device.user_id = v_uid
      and device.device_id = v_device_id
      and device.is_active = true
      and device.revoked_at is null
      and coalesce(device.approval_status, 'approved') = 'approved'
      and device.routing_status = 'ready'
      and nullif(trim(device.device_authorization_signature), '') is not null
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_AUTHORIZED');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || v_device_id, 1));

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

  insert into public.device_one_time_prekeys (user_id, device_id, opk_id, public_key)
  select v_uid, v_device_id, item.opk_id, item.public_key
  from jsonb_to_recordset(p_prekeys) as item(opk_id integer, public_key text)
  on conflict (user_id, device_id, opk_id) do nothing;

  select array_agg(item.opk_id order by item.opk_id)
    into v_accepted
  from jsonb_to_recordset(p_prekeys) as item(opk_id integer, public_key text);

  return jsonb_build_object(
    'ok', true,
    'code', 'ONE_TIME_PREKEYS_PUBLISHED',
    'accepted_ids', to_jsonb(coalesce(v_accepted, array[]::integer[]))
  );
end;
$$;

revoke all on function public.publish_device_one_time_prekeys(text,jsonb) from public, anon;
grant execute on function public.publish_device_one_time_prekeys(text,jsonb) to authenticated;

drop function if exists public.claim_device_one_time_prekey(uuid,text);
drop function if exists public.claim_device_one_time_prekey(uuid,text,uuid,text);
create function public.claim_device_one_time_prekey(
  p_user_id uuid,
  p_device_id text,
  p_conversation_id uuid,
  p_sender_device_id text
)
returns table (opk_id integer, public_key text)
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_conversation_id is null then
    return;
  end if;
  if not exists (
    select 1 from public.conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.user_id = v_uid
  ) or not exists (
    select 1 from public.conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.user_id = p_user_id
  ) then
    return;
  end if;
  if not exists (
    select 1
    from public.get_sesame_device_list(v_uid) sender_device
    where sender_device.device_id = trim(p_sender_device_id)
      and sender_device.is_routable = true
  ) then
    return;
  end if;
  if not exists (
    select 1
    from public.get_sesame_device_list(p_user_id) device
    where device.device_id = trim(p_device_id)
      and device.is_routable = true
  ) then
    return;
  end if;

  return query
  with picked as (
    select item.id, item.opk_id, item.public_key
    from public.device_one_time_prekeys item
    where item.user_id = p_user_id
      and item.device_id = trim(p_device_id)
    order by item.created_at, item.opk_id
    limit 1
    for update skip locked
  ), deleted as (
    delete from public.device_one_time_prekeys item
    using picked
    where item.id = picked.id
    returning picked.opk_id, picked.public_key
  )
  select deleted.opk_id, deleted.public_key from deleted;
end;
$$;

revoke all on function public.claim_device_one_time_prekey(uuid,text,uuid,text) from public, anon;
grant execute on function public.claim_device_one_time_prekey(uuid,text,uuid,text) to authenticated;

create or replace function public.count_device_one_time_prekeys(
  p_user_id uuid,
  p_device_id text
)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_user_id then
    return 0;
  end if;
  return (
    select count(*)::integer
    from public.device_one_time_prekeys
    where user_id = p_user_id
      and device_id = trim(p_device_id)
  );
end;
$$;

revoke all on function public.count_device_one_time_prekeys(uuid,text) from public, anon;
grant execute on function public.count_device_one_time_prekeys(uuid,text) to authenticated;

create or replace function public.get_device_prekey_bundle(
  p_user_id uuid,
  p_device_id text
)
returns table (spk_id integer, public_key text, signature text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select spk.spk_id, spk.public_key, spk.signature
  from public.device_signed_prekeys spk
  where spk.user_id = p_user_id
    and spk.device_id = trim(p_device_id)
    and spk.is_active = true
    and spk.expires_at > now()
    and exists (
      select 1
      from public.get_sesame_device_list(p_user_id) device
      where device.device_id = trim(p_device_id)
        and device.is_routable = true
    )
  order by spk.created_at desc, spk.spk_id desc
  limit 1;
$$;

revoke all on function public.get_device_prekey_bundle(uuid,text) from public, anon;
grant execute on function public.get_device_prekey_bundle(uuid,text) to authenticated;

create or replace function public.get_device_copies_for_messages(
  p_message_ids uuid[],
  p_device_id text
)
returns table (
  message_id uuid,
  encrypted_body text,
  sender_user_id uuid,
  sender_device_id text,
  recipient_device_id text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    copy.message_id,
    copy.encrypted_body,
    copy.sender_user_id,
    copy.sender_device_id,
    copy.recipient_device_id,
    copy.created_at
  from public.message_device_copies copy
  join public.messages message on message.id = copy.message_id
  where copy.message_id = any(coalesce(p_message_ids, array[]::uuid[]))
    and copy.recipient_user_id = auth.uid()
    and copy.recipient_device_id = trim(p_device_id)
    and message.sender_id = copy.sender_user_id
  order by copy.created_at, copy.message_id;
$$;

revoke all on function public.get_device_copies_for_messages(uuid[],text) from public, anon;
grant execute on function public.get_device_copies_for_messages(uuid[],text) to authenticated;

create function public.mark_current_device_route_ready(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  update public.user_devices device
  set routing_status = 'ready',
      routing_error = null,
      routing_checked_at = now(),
      updated_at = now()
  where device.user_id = v_uid
    and device.device_id = trim(p_device_id)
    and device.is_active = true
    and device.revoked_at is null
    and coalesce(device.approval_status, 'approved') = 'approved'
    and nullif(trim(device.device_public_key), '') is not null
    and nullif(trim(device.device_signing_key), '') is not null
    and nullif(trim(device.device_authorization_signature), '') is not null
    and exists (
      select 1 from public.user_public_keys account
      where account.user_id = v_uid
        and account.is_active = true
        and account.identity_binding_version = 1
        and nullif(trim(account.identity_binding_signature), '') is not null
    )
    and exists (
      select 1 from public.device_signed_prekeys spk
      where spk.user_id = v_uid
        and spk.device_id = trim(p_device_id)
        and spk.is_active = true
        and spk.expires_at > now()
    );

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ROUTE_INCOMPLETE');
  end if;
  return jsonb_build_object('ok', true, 'code', 'DEVICE_ROUTE_READY');
end;
$$;

revoke all on function public.mark_current_device_route_ready(text) from public, anon;
grant execute on function public.mark_current_device_route_ready(text) to authenticated;

create function public.approve_user_device(p_device_id text)
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
  set approval_status = 'approved',
      is_active = true,
      approved_at = coalesce(device.approved_at, now()),
      approved_by = coalesce(device.approved_by, v_uid),
      rejected_at = null,
      rejected_by = null,
      stale_at = null,
      last_seen_at = now(),
      updated_at = now()
  where device.user_id = v_uid
    and device.device_id = v_device_id
    and device.revoked_at is null
    and coalesce(device.approval_status, 'approved') <> 'rejected'
    and nullif(trim(device.device_public_key), '') is not null
    and nullif(trim(device.device_signing_key), '') is not null
    and nullif(trim(device.device_authorization_signature), '') is not null;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_ELIGIBLE');
  end if;
  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_APPROVED',
    'device_id', v_device_id
  );
end;
$$;

revoke all on function public.approve_user_device(text) from public, anon;
grant execute on function public.approve_user_device(text) to authenticated;

-- The stage-2 exactly-idempotent transport must still exist after replacing
-- the device authority functions.
do $$
begin
  if to_regprocedure(
    'public.aegis_send_message(uuid,uuid,text,text,jsonb,jsonb,text,text)'
  ) is null then
    raise exception 'AEGIS_SEND_RPC_WAS_REMOVED';
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;
