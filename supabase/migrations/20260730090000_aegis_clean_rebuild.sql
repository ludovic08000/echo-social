-- Aegis final clean rebuild migration.
--
-- This is an intentionally destructive development cutover. The project has no
-- compatibility requirement for messages, calls, device routes, prekeys or
-- recovery rows created by the abandoned Aegis prototypes. User accounts and
-- unrelated social data remain intact.

begin;

create extension if not exists pgcrypto with schema extensions;

-- Remove objects left by a partial local run of the five superseded migrations.
drop trigger if exists aegis_stage_view_once_payload on public.messages;
drop function if exists public.stage_aegis_view_once_payload();
drop function if exists public.begin_aegis_view_once_consume(uuid, text);
drop function if exists public.commit_aegis_view_once_consume(uuid, text, uuid);
drop function if exists public.release_aegis_view_once_claim(uuid, text, uuid);
drop function if exists public.delete_aegis_message_for_me(uuid);
drop function if exists public.delete_aegis_message_for_everyone(uuid);
drop function if exists public.aegis_call_create(uuid, uuid, text, text, uuid[], jsonb);
drop function if exists public.aegis_call_get_invitation(uuid, text);
drop function if exists public.aegis_call_latest_for_device(text);
drop function if exists public.aegis_call_update_status(uuid, text, text);
drop function if exists public.write_aegis_recovery_vault(smallint, bigint, text, text, text, text);
drop table if exists public.aegis_view_once_consumptions;
drop table if exists public.aegis_view_once_payloads;
drop table if exists public.aegis_call_invitations;
drop table if exists public.aegis_recovery_vaults;

-- Remove obsolete callable paths by name, including every historical overload.
do $$
declare
  obsolete record;
begin
  for obsolete in
    select procedure.oid::regprocedure as signature
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'public'
      and procedure.proname = any (array[
        'call_signal',
        'aegis_ack_device_messages',
        'aegis_sync_device',
        'send_message_with_device_copies',
        'insert_message_with_device_copies'
      ])
  loop
    execute format('drop function if exists %s cascade', obsolete.signature);
  end loop;
end;
$$;

-- Remove the pre-Aegis destructive-view implementation. The final claim/commit
-- protocol below is the only active view-once path.
drop trigger if exists trg_scrub_view_once on public.messages;
drop function if exists public.scrub_view_once_on_view();
drop policy if exists msg_update_view_once_viewer on public.messages;

-- Development data reset. FK-dependent message/call/device rows are removed by
-- CASCADE, while auth.users, profiles, posts and unrelated product data remain.
do $$
begin
  if to_regclass('public.messages') is not null then
    execute 'truncate table public.messages cascade';
  end if;
  if to_regclass('public.active_calls') is not null then
    execute 'truncate table public.active_calls cascade';
  end if;
  if to_regclass('public.device_one_time_prekeys') is not null then
    execute 'truncate table public.device_one_time_prekeys cascade';
  end if;
  if to_regclass('public.device_signed_prekeys') is not null then
    execute 'truncate table public.device_signed_prekeys cascade';
  end if;
  if to_regclass('public.user_devices') is not null then
    execute 'truncate table public.user_devices cascade';
  end if;
  if to_regclass('public.user_public_keys') is not null then
    execute 'truncate table public.user_public_keys cascade';
  end if;
  if to_regclass('public.aegis_user_route_versions') is not null then
    execute 'truncate table public.aegis_user_route_versions cascade';
  end if;
end;
$$;

-- A call key may exist only as a per-device encrypted invitation envelope.
alter table public.active_calls
  drop column if exists encrypted_call_key cascade;

-- Stage 2: immutable authoritative transport.
-- Aegis clean transport transaction.
--
-- One stable message UUID identifies one immutable encrypted request. Calls for
-- the same UUID are serialized inside PostgreSQL, so a retry can never race the
-- original call and then rewind a Ratchet that has already committed.



alter table public.messages
  add column if not exists aegis_request_digest text;

comment on column public.messages.aegis_request_digest is
  'SHA-256 of the complete immutable Aegis send request used for exact idempotency.';

drop function if exists public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text, text
);

create function public.aegis_send_message(
  p_message_id uuid,
  p_conversation_id uuid,
  p_body text,
  p_image_url text,
  p_extra jsonb,
  p_copies jsonb,
  p_sender_device_id text,
  p_route_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_existing_sender uuid;
  v_existing_digest text;
  v_current_route_version text;
  v_copies jsonb := coalesce(p_copies, '[]'::jsonb);
  v_normalized_copies jsonb := '[]'::jsonb;
  v_request_digest text;
  v_copies_count integer := 0;
  v_distinct_copy_count integer := 0;
  v_bad_copy_count integer := 0;
  v_missing_count integer := 0;
  v_unexpected_count integer := 0;
  v_unroutable_participants integer := 0;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_message_id is null or p_conversation_id is null then
    raise exception 'AEGIS_STABLE_UUID_REQUIRED' using errcode = '23502';
  end if;
  if jsonb_typeof(v_copies) <> 'array' then
    raise exception 'E2EE_INVALID_DEVICE_COPY' using errcode = '23514';
  end if;

  -- Normalize only fields that are accepted and written by this RPC. JSONB has
  -- deterministic object-key ordering; the explicit row order makes the array
  -- independent of client ordering.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'recipient_user_id', copy.recipient_user_id,
        'recipient_device_id', copy.recipient_device_id,
        'sender_device_id', copy.sender_device_id,
        'encrypted_body', copy.encrypted_body
      )
      order by
        copy.recipient_user_id,
        copy.recipient_device_id,
        copy.sender_device_id,
        copy.encrypted_body
    ),
    '[]'::jsonb
  )
  into v_normalized_copies
  from jsonb_to_recordset(v_copies) as copy(
    recipient_user_id uuid,
    recipient_device_id text,
    sender_device_id text,
    encrypted_body text
  );

  v_request_digest := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'message_id', p_message_id,
          'conversation_id', p_conversation_id,
          'sender_user_id', v_uid,
          'body', p_body,
          'image_url', nullif(p_image_url, ''),
          'extra', coalesce(p_extra, '{}'::jsonb),
          'sender_device_id', trim(coalesce(p_sender_device_id, '')),
          'route_version', p_route_version,
          'copies', v_normalized_copies
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  -- Serialize every original call, timeout confirmation and later outbox retry
  -- for this UUID. A confirmation cannot overtake a still-running insert.
  perform pg_advisory_xact_lock(hashtextextended(p_message_id::text, 0));

  -- Exact confirmation precedes current membership, device and route checks.
  -- A message already committed remains confirmable if a user later leaves the
  -- conversation or a device is subsequently revoked.
  select message.sender_id, message.aegis_request_digest
    into v_existing_sender, v_existing_digest
  from public.messages message
  where message.id = p_message_id;

  if found then
    if v_existing_sender = v_uid
       and v_existing_digest is not null
       and v_existing_digest = v_request_digest then
      return jsonb_build_object(
        'state', 'committed',
        'message_id', p_message_id,
        'request_digest', v_request_digest,
        'existing', true
      );
    end if;
    raise exception 'MESSAGE_ID_CONFLICT' using errcode = '23505';
  end if;

  if not exists (
    select 1
    from public.conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.user_id = v_uid
  ) then
    raise exception 'sender_not_conversation_participant'
      using errcode = '42501';
  end if;

  if not public.is_supported_aegis_message(p_body, 'multi_device') then
    raise exception 'AEGIS_WIRE_FORMAT_REJECTED' using errcode = '23514';
  end if;
  if length(trim(coalesce(p_sender_device_id, ''))) < 8 then
    raise exception 'E2EE_SENDER_DEVICE_REQUIRED' using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.get_sesame_device_list(v_uid) own_device
    where own_device.device_id = trim(p_sender_device_id)
      and own_device.is_routable = true
  ) then
    raise exception 'E2EE_SENDER_DEVICE_NOT_TRUSTED'
      using errcode = '23514';
  end if;

  -- Lock every participant route counter until the parent and all copies commit.
  insert into public.aegis_user_route_versions (user_id, route_version)
  select participant.user_id, 1
  from public.conversation_participants participant
  where participant.conversation_id = p_conversation_id
  on conflict (user_id) do nothing;

  perform route.user_id
  from public.aegis_user_route_versions route
  join public.conversation_participants participant
    on participant.user_id = route.user_id
  where participant.conversation_id = p_conversation_id
  order by route.user_id
  for share of route;

  v_current_route_version :=
    public.get_aegis_conversation_route_version(p_conversation_id);
  if p_route_version is null
     or p_route_version is distinct from v_current_route_version then
    raise exception 'E2EE_DEVICE_LIST_STALE'
      using errcode = '23514',
            detail = format(
              'Prepared route %s does not match current route %s.',
              coalesce(p_route_version, 'NULL'),
              v_current_route_version
            );
  end if;

  with supplied as (
    select *
    from jsonb_to_recordset(v_normalized_copies) as copy(
      recipient_user_id uuid,
      recipient_device_id text,
      sender_device_id text,
      encrypted_body text
    )
  )
  select
    count(*),
    count(distinct (recipient_user_id, recipient_device_id))
  into v_copies_count, v_distinct_copy_count
  from supplied;

  if v_copies_count = 0 then
    raise exception 'E2EE_NO_SECURE_TARGET' using errcode = '23514';
  end if;
  if v_copies_count <> v_distinct_copy_count then
    raise exception 'E2EE_DUPLICATE_DEVICE_COPY' using errcode = '23514';
  end if;

  with supplied as (
    select *
    from jsonb_to_recordset(v_normalized_copies) as copy(
      recipient_user_id uuid,
      recipient_device_id text,
      sender_device_id text,
      encrypted_body text
    )
  )
  select count(*)
  into v_bad_copy_count
  from supplied copy
  where copy.recipient_user_id is null
     or length(trim(coalesce(copy.recipient_device_id, ''))) < 8
     or copy.sender_device_id is distinct from trim(p_sender_device_id)
     or not (
       copy.encrypted_body like 'aegis1.ratchet.%'
       or copy.encrypted_body like 'aegis1.init.v1.%'
     );

  if v_bad_copy_count > 0 then
    raise exception 'E2EE_INVALID_DEVICE_COPY' using errcode = '23514';
  end if;

  select count(*)
  into v_unroutable_participants
  from (
    select distinct participant.user_id
    from public.conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.user_id <> v_uid
  ) peer
  where not exists (
    select 1
    from public.get_sesame_device_list(peer.user_id) device
    where device.is_routable = true
  );

  if v_unroutable_participants > 0 then
    raise exception 'E2EE_PARTICIPANT_ROUTE_UNAVAILABLE'
      using errcode = '23514';
  end if;

  with expected as (
    select distinct
      participant.user_id as recipient_user_id,
      device.device_id as recipient_device_id
    from public.conversation_participants participant
    cross join lateral public.get_sesame_device_list(participant.user_id) device
    where participant.conversation_id = p_conversation_id
      and device.is_routable = true
      and not (
        participant.user_id = v_uid
        and device.device_id = trim(p_sender_device_id)
      )
  ),
  supplied as (
    select *
    from jsonb_to_recordset(v_normalized_copies) as copy(
      recipient_user_id uuid,
      recipient_device_id text,
      sender_device_id text,
      encrypted_body text
    )
  )
  select
    count(*) filter (where supplied.recipient_device_id is null),
    (
      select count(*)
      from supplied copy
      where not exists (
        select 1
        from expected route
        where route.recipient_user_id = copy.recipient_user_id
          and route.recipient_device_id = copy.recipient_device_id
      )
    )
  into v_missing_count, v_unexpected_count
  from expected
  left join supplied
    on supplied.recipient_user_id = expected.recipient_user_id
   and supplied.recipient_device_id = expected.recipient_device_id;

  if v_missing_count > 0 or v_unexpected_count > 0 then
    raise exception 'E2EE_DEVICE_LIST_STALE'
      using errcode = '23514',
            detail = format(
              'Stable route mismatch: %s missing, %s unexpected.',
              v_missing_count,
              v_unexpected_count
            );
  end if;

  insert into public.messages (
    id, conversation_id, sender_id, body, image_url, body_kind,
    view_once, expires_at, document_url, document_name, document_mime,
    document_size_bytes, archive_body, aegis_route_version,
    aegis_request_digest
  )
  values (
    p_message_id,
    p_conversation_id,
    v_uid,
    p_body,
    nullif(p_image_url, ''),
    'multi_device',
    coalesce((coalesce(p_extra, '{}'::jsonb)->>'view_once')::boolean, false),
    nullif(coalesce(p_extra, '{}'::jsonb)->>'expires_at', '')::timestamptz,
    nullif(coalesce(p_extra, '{}'::jsonb)->>'document_url', ''),
    nullif(coalesce(p_extra, '{}'::jsonb)->>'document_name', ''),
    nullif(coalesce(p_extra, '{}'::jsonb)->>'document_mime', ''),
    nullif(coalesce(p_extra, '{}'::jsonb)->>'document_size_bytes', '')::integer,
    nullif(coalesce(p_extra, '{}'::jsonb)->>'archive_body', ''),
    p_route_version,
    v_request_digest
  );

  insert into public.message_device_copies (
    message_id, recipient_user_id, recipient_device_id,
    sender_user_id, sender_device_id, encrypted_body
  )
  select
    p_message_id,
    copy.recipient_user_id,
    copy.recipient_device_id,
    v_uid,
    copy.sender_device_id,
    copy.encrypted_body
  from jsonb_to_recordset(v_normalized_copies) as copy(
    recipient_user_id uuid,
    recipient_device_id text,
    sender_device_id text,
    encrypted_body text
  );

  return jsonb_build_object(
    'state', 'committed',
    'message_id', p_message_id,
    'request_digest', v_request_digest,
    'existing', false
  );
end;
$$;

revoke all on function public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text, text
) from public, anon;
grant execute on function public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text, text
) to authenticated;

comment on function public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text, text
) is 'Serializes one immutable Aegis request per message UUID and returns an authoritative commit receipt.';

-- Stage 3: account-authorized device registry and prekeys.
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

-- Stage 5: call-scoped rooms and per-device call-key envelopes.
alter table public.active_calls
  add column if not exists room_name text,
  add column if not exists caller_device_id text,
  add column if not exists protocol_version integer not null default 1;

-- Stage 9 truncates development calls before this schema is installed. No
-- legacy room-name compatibility is retained.

alter table public.active_calls
  alter column room_name set not null;

create unique index if not exists active_calls_room_name_uidx
  on public.active_calls(room_name);

create table if not exists public.aegis_call_invitations (
  call_id uuid not null references public.active_calls(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_device_id text not null,
  encrypted_call_key text not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  primary key (call_id, recipient_device_id),
  unique (call_id, recipient_user_id, recipient_device_id),
  check (length(recipient_device_id) >= 8),
  check (encrypted_call_key like 'aegis-call-v1.%')
);

create index if not exists aegis_call_invitations_recipient_idx
  on public.aegis_call_invitations(recipient_user_id, recipient_device_id, status, created_at desc);

alter table public.aegis_call_invitations enable row level security;

revoke all on table public.aegis_call_invitations from public, anon;
grant select on table public.aegis_call_invitations to authenticated;

drop policy if exists aegis_call_invitation_recipient_read on public.aegis_call_invitations;
create policy aegis_call_invitation_recipient_read
on public.aegis_call_invitations
for select
to authenticated
using (recipient_user_id = auth.uid());

create or replace function public.aegis_call_create(
  p_call_id uuid,
  p_conversation_id uuid,
  p_call_type text,
  p_caller_device_id text,
  p_invitee_ids uuid[],
  p_invitations jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_invitees uuid[];
  v_first_invitee uuid;
  v_expected_count integer;
  v_supplied_count integer;
  v_room_name text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if p_call_id is null or p_conversation_id is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CALL_ID');
  end if;
  if p_call_type not in ('audio', 'video') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CALL_TYPE');
  end if;
  if length(trim(coalesce(p_caller_device_id, ''))) < 8 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CALLER_DEVICE');
  end if;
  if jsonb_typeof(p_invitations) is distinct from 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INVITATIONS');
  end if;

  select array_agg(distinct invitee order by invitee)
  into v_invitees
  from unnest(coalesce(p_invitee_ids, array[]::uuid[])) invitee
  where invitee is not null and invitee <> v_uid;

  if coalesce(cardinality(v_invitees), 0) < 1 or cardinality(v_invitees) > 7 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_INVITEE_COUNT');
  end if;
  v_first_invitee := v_invitees[1];

  if not exists (
    select 1 from public.conversation_participants cp
    where cp.conversation_id = p_conversation_id and cp.user_id = v_uid
  ) then
    return jsonb_build_object('ok', false, 'code', 'CALLER_NOT_IN_CONVERSATION');
  end if;

  if exists (
    select 1
    from unnest(v_invitees) invitee
    where not exists (
      select 1 from public.conversation_participants cp
      where cp.conversation_id = p_conversation_id and cp.user_id = invitee
    )
    and not exists (
      select 1 from public.friendships friendship
      where friendship.status = 'accepted'
        and (
          (friendship.requester_id = v_uid and friendship.addressee_id = invitee)
          or (friendship.addressee_id = v_uid and friendship.requester_id = invitee)
        )
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVITEE_NOT_AUTHORIZED');
  end if;

  if not exists (
    select 1 from public.user_devices device
    where device.user_id = v_uid
      and device.device_id = p_caller_device_id
      and device.is_active = true
      and device.revoked_at is null
      and coalesce(device.approval_status, 'approved') = 'approved'
      and coalesce(device.routing_status, 'repairing') <> 'unavailable'
      and nullif(trim(device.device_authorization_signature), '') is not null
  ) then
    return jsonb_build_object('ok', false, 'code', 'CALLER_DEVICE_NOT_AUTHORIZED');
  end if;

  with expected as (
    select device.user_id, device.device_id
    from public.user_devices device
    where device.user_id = any(v_invitees)
      and device.is_active = true
      and device.revoked_at is null
      and coalesce(device.approval_status, 'approved') = 'approved'
      and coalesce(device.routing_status, 'repairing') <> 'unavailable'
      and nullif(trim(device.device_public_key), '') is not null
      and nullif(trim(device.device_authorization_signature), '') is not null
  ), supplied as (
    select
      (entry->>'recipient_user_id')::uuid as user_id,
      trim(entry->>'recipient_device_id') as device_id,
      entry->>'encrypted_call_key' as encrypted_call_key
    from jsonb_array_elements(p_invitations) entry
  )
  select (select count(*) from expected), (select count(*) from supplied)
  into v_expected_count, v_supplied_count;

  if v_expected_count = 0 or v_expected_count <> v_supplied_count then
    return jsonb_build_object('ok', false, 'code', 'INCOMPLETE_CALL_DEVICE_FANOUT');
  end if;

  if exists (
    with expected as (
      select device.user_id, device.device_id
      from public.user_devices device
      where device.user_id = any(v_invitees)
        and device.is_active = true
        and device.revoked_at is null
        and coalesce(device.approval_status, 'approved') = 'approved'
        and coalesce(device.routing_status, 'repairing') <> 'unavailable'
        and nullif(trim(device.device_public_key), '') is not null
        and nullif(trim(device.device_authorization_signature), '') is not null
    ), supplied as (
      select
        (entry->>'recipient_user_id')::uuid as user_id,
        trim(entry->>'recipient_device_id') as device_id,
        entry->>'encrypted_call_key' as encrypted_call_key
      from jsonb_array_elements(p_invitations) entry
    )
    (select user_id, device_id from expected
     except
     select user_id, device_id from supplied)
    union all
    (select user_id, device_id from supplied
     except
     select user_id, device_id from expected)
  ) then
    return jsonb_build_object('ok', false, 'code', 'CALL_DEVICE_ROUTE_MISMATCH');
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_invitations) entry
    where length(trim(coalesce(entry->>'recipient_device_id', ''))) < 8
       or coalesce(entry->>'encrypted_call_key', '') not like 'aegis-call-v1.%'
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CALL_KEY_ENVELOPE');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_call_id::text, 0));
  if exists (select 1 from public.active_calls where id = p_call_id) then
    return jsonb_build_object('ok', false, 'code', 'CALL_ID_ALREADY_EXISTS');
  end if;

  v_room_name := 'call-' || p_call_id::text;

  insert into public.active_calls (
    id, conversation_id, caller_id, callee_id, caller_ids, is_group,
    room_id, room_name, caller_device_id, protocol_version,
    call_type, status
  ) values (
    p_call_id, p_conversation_id, v_uid, v_first_invitee, v_invitees,
    cardinality(v_invitees) > 1,
    p_call_id, v_room_name, p_caller_device_id, 5,
    p_call_type, 'ringing'
  );

  insert into public.aegis_call_invitations (
    call_id, recipient_user_id, recipient_device_id, encrypted_call_key
  )
  select
    p_call_id,
    (entry->>'recipient_user_id')::uuid,
    trim(entry->>'recipient_device_id'),
    entry->>'encrypted_call_key'
  from jsonb_array_elements(p_invitations) entry;

  return jsonb_build_object(
    'ok', true,
    'code', 'CALL_CREATED',
    'call_id', p_call_id,
    'room_name', v_room_name,
    'invitation_count', v_expected_count
  );
exception
  when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'CALL_ALREADY_EXISTS');
  when others then
    raise;
end;
$$;

revoke all on function public.aegis_call_create(uuid,uuid,text,text,uuid[],jsonb) from public, anon;
grant execute on function public.aegis_call_create(uuid,uuid,text,text,uuid[],jsonb) to authenticated;

create or replace function public.aegis_call_get_invitation(
  p_call_id uuid,
  p_device_id text
)
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select coalesce((
    select jsonb_build_object(
      'ok', true,
      'call_id', call.id,
      'conversation_id', call.conversation_id,
      'caller_id', call.caller_id,
      'call_type', call.call_type,
      'is_group', call.is_group,
      'room_name', call.room_name,
      'encrypted_call_key', invitation.encrypted_call_key,
      'invitation_status', invitation.status
    )
    from public.aegis_call_invitations invitation
    join public.active_calls call on call.id = invitation.call_id
    where invitation.call_id = p_call_id
      and invitation.recipient_user_id = auth.uid()
      and invitation.recipient_device_id = trim(p_device_id)
      and invitation.status in ('pending', 'accepted')
      and call.status in ('ringing', 'answered', 'accepted')
      and call.protocol_version = 5
  ), jsonb_build_object('ok', false, 'code', 'CALL_INVITATION_NOT_FOUND'));
$$;

revoke all on function public.aegis_call_get_invitation(uuid,text) from public, anon;
grant execute on function public.aegis_call_get_invitation(uuid,text) to authenticated;

create or replace function public.aegis_call_latest_for_device(p_device_id text)
returns jsonb
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'ok', true,
    'call', coalesce((
      select jsonb_build_object(
        'id', call.id,
        'conversation_id', call.conversation_id,
        'caller_id', call.caller_id,
        'callee_id', invitation.recipient_user_id,
        'call_type', call.call_type,
        'status', call.status,
        'is_group', call.is_group,
        'room_name', call.room_name,
        'created_at', call.created_at
      )
      from public.aegis_call_invitations invitation
      join public.active_calls call on call.id = invitation.call_id
      where invitation.recipient_user_id = auth.uid()
        and invitation.recipient_device_id = trim(p_device_id)
        and invitation.status = 'pending'
        and call.status = 'ringing'
        and call.protocol_version = 5
        and call.created_at > now() - interval '45 seconds'
      order by call.created_at desc
      limit 1
    ), 'null'::jsonb)
  );
$$;

revoke all on function public.aegis_call_latest_for_device(text) from public, anon;
grant execute on function public.aegis_call_latest_for_device(text) to authenticated;

create or replace function public.aegis_call_update_status(
  p_call_id uuid,
  p_device_id text,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_call public.active_calls%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if p_status not in ('accepted', 'declined', 'ended', 'cancelled') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CALL_STATUS');
  end if;

  select * into v_call from public.active_calls where id = p_call_id for update;
  if not found or v_call.protocol_version <> 5 then
    return jsonb_build_object('ok', false, 'code', 'CALL_NOT_FOUND');
  end if;

  if v_call.caller_id = v_uid then
    if p_device_id is distinct from v_call.caller_device_id then
      return jsonb_build_object('ok', false, 'code', 'CALLER_DEVICE_MISMATCH');
    end if;
    if p_status not in ('ended', 'cancelled') then
      return jsonb_build_object('ok', false, 'code', 'CALLER_STATUS_NOT_ALLOWED');
    end if;
    update public.active_calls
    set status = p_status,
        ended_at = coalesce(ended_at, now())
    where id = p_call_id;
    return jsonb_build_object('ok', true, 'code', 'CALL_CLOSED');
  end if;

  update public.aegis_call_invitations
  set status = p_status,
      responded_at = now()
  where call_id = p_call_id
    and recipient_user_id = v_uid
    and recipient_device_id = trim(p_device_id)
    and status = 'pending';

  if not found then
    return jsonb_build_object('ok', false, 'code', 'CALL_INVITATION_NOT_PENDING');
  end if;

  if p_status = 'accepted' then
    update public.active_calls
    set status = 'answered',
        answered_at = coalesce(answered_at, now())
    where id = p_call_id and status = 'ringing';
  elsif not exists (
    select 1 from public.aegis_call_invitations
    where call_id = p_call_id and status in ('pending', 'accepted')
  ) then
    update public.active_calls
    set status = 'declined',
        ended_at = coalesce(ended_at, now())
    where id = p_call_id;
  end if;

  return jsonb_build_object('ok', true, 'code', 'CALL_INVITATION_UPDATED');
end;
$$;

revoke all on function public.aegis_call_update_status(uuid,text,text) from public, anon;
grant execute on function public.aegis_call_update_status(uuid,text,text) to authenticated;

-- The RPCs above are the only call mutation path. Existing SELECT policies may
-- expose ringing metadata, but direct INSERT/UPDATE/DELETE policies are removed.
do $$
declare
  policy record;
begin
  for policy in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'active_calls'
      and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
  loop
    execute format('drop policy if exists %I on public.active_calls', policy.policyname);
  end loop;
end;
$$;

revoke insert, update, delete on table public.active_calls from public, anon, authenticated;
grant select on table public.active_calls to authenticated;

-- Stage 6: account-identity recovery vault.
create table if not exists public.aegis_recovery_vaults (
  user_id uuid primary key references auth.users(id) on delete cascade,
  protocol_version smallint not null check (protocol_version = 1),
  generation bigint not null check (generation > 0),
  identity_fingerprint text not null check (length(identity_fingerprint) between 16 and 256),
  kdf_salt text not null check (length(kdf_salt) between 32 and 256),
  nonce text not null check (length(nonce) between 12 and 128),
  ciphertext text not null check (length(ciphertext) between 64 and 1048576),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.aegis_recovery_vaults enable row level security;

revoke all on table public.aegis_recovery_vaults from anon, authenticated;
grant select on table public.aegis_recovery_vaults to authenticated;

drop policy if exists aegis_recovery_vault_select_own on public.aegis_recovery_vaults;
create policy aegis_recovery_vault_select_own
  on public.aegis_recovery_vaults
  for select
  to authenticated
  using (user_id = auth.uid());

create or replace function public.write_aegis_recovery_vault(
  p_protocol_version smallint,
  p_generation bigint,
  p_identity_fingerprint text,
  p_kdf_salt text,
  p_nonce text,
  p_ciphertext text
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_current_generation bigint;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_protocol_version <> 1 then
    raise exception 'UNSUPPORTED_RECOVERY_VERSION' using errcode = '22023';
  end if;
  if p_generation < 1 then
    raise exception 'INVALID_RECOVERY_GENERATION' using errcode = '22023';
  end if;
  if length(p_identity_fingerprint) not between 16 and 256
    or length(p_kdf_salt) not between 32 and 256
    or length(p_nonce) not between 12 and 128
    or length(p_ciphertext) not between 64 and 1048576 then
    raise exception 'INVALID_RECOVERY_VAULT_PAYLOAD' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':aegis-recovery-v1', 0));

  select generation
    into v_current_generation
    from public.aegis_recovery_vaults
   where user_id = v_user_id
   for update;

  if v_current_generation is null then
    if p_generation <> 1 then
      raise exception 'STALE_RECOVERY_GENERATION' using errcode = '40001';
    end if;
  elsif p_generation <> v_current_generation + 1 then
    raise exception 'STALE_RECOVERY_GENERATION' using errcode = '40001';
  end if;

  insert into public.aegis_recovery_vaults (
    user_id,
    protocol_version,
    generation,
    identity_fingerprint,
    kdf_salt,
    nonce,
    ciphertext,
    created_at,
    updated_at
  ) values (
    v_user_id,
    p_protocol_version,
    p_generation,
    p_identity_fingerprint,
    p_kdf_salt,
    p_nonce,
    p_ciphertext,
    now(),
    now()
  )
  on conflict (user_id) do update set
    protocol_version = excluded.protocol_version,
    generation = excluded.generation,
    identity_fingerprint = excluded.identity_fingerprint,
    kdf_salt = excluded.kdf_salt,
    nonce = excluded.nonce,
    ciphertext = excluded.ciphertext,
    updated_at = now();

  return p_generation;
end;
$$;

revoke all on function public.write_aegis_recovery_vault(smallint, bigint, text, text, text, text) from public, anon;
grant execute on function public.write_aegis_recovery_vault(smallint, bigint, text, text, text, text) to authenticated;

-- Stage 7: destructive view-once claim and consumption.
-- Aegis view-once delivery and destructive consumption.
--
-- The normal Aegis send RPC commits the immutable parent and complete device
-- fan-out first. A deferred trigger then moves the encrypted parent and the
-- recipient-specific capsules into a sealed per-user payload, removes every
-- normal device copy and redacts the visible parent row. The payload is exposed
-- only through the claim/commit RPCs below.



create table if not exists public.aegis_view_once_payloads (
  message_id uuid not null references public.messages(id) on delete cascade,
  conversation_id uuid not null,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  parent_body text not null,
  image_url text not null,
  device_copies jsonb not null check (jsonb_typeof(device_copies) = 'array'),
  claim_token uuid,
  claimed_device_id text,
  claim_expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (message_id, recipient_user_id)
);

create table if not exists public.aegis_view_once_consumptions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  claim_token uuid not null,
  consumed_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

alter table public.aegis_view_once_payloads enable row level security;
alter table public.aegis_view_once_consumptions enable row level security;

revoke all on table public.aegis_view_once_payloads from public, anon, authenticated;
revoke all on table public.aegis_view_once_consumptions from public, anon, authenticated;
grant select on table public.aegis_view_once_consumptions to authenticated;

drop policy if exists aegis_view_once_consumption_select_own on public.aegis_view_once_consumptions;
create policy aegis_view_once_consumption_select_own
  on public.aegis_view_once_consumptions
  for select
  to authenticated
  using (user_id = auth.uid());

create or replace function public.stage_aegis_view_once_payload()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_payload_count integer := 0;
begin
  if new.view_once is not true then
    return new;
  end if;
  if new.body_kind is distinct from 'multi_device'
     or new.aegis_request_digest is null
     or nullif(new.image_url, '') is null
     or nullif(new.document_url, '') is not null then
    raise exception 'AEGIS_VIEW_ONCE_MEDIA_REQUIRED' using errcode = '23514';
  end if;

  insert into public.aegis_view_once_payloads (
    message_id,
    conversation_id,
    sender_user_id,
    recipient_user_id,
    parent_body,
    image_url,
    device_copies
  )
  select
    new.id,
    new.conversation_id,
    new.sender_id,
    copy.recipient_user_id,
    new.body,
    new.image_url,
    jsonb_agg(
      jsonb_build_object(
        'recipient_device_id', copy.recipient_device_id,
        'sender_device_id', copy.sender_device_id,
        'encrypted_body', copy.encrypted_body
      )
      order by copy.recipient_device_id, copy.sender_device_id
    )
  from public.message_device_copies copy
  where copy.message_id = new.id
    and copy.recipient_user_id <> new.sender_id
  group by copy.recipient_user_id;

  get diagnostics v_payload_count = row_count;
  if v_payload_count = 0 then
    raise exception 'AEGIS_VIEW_ONCE_RECIPIENT_PAYLOAD_MISSING' using errcode = '23514';
  end if;

  delete from public.message_device_copies where message_id = new.id;
  delete from public.message_archives where message_id = new.id;

  update public.messages
     set body = '🔒 Vue unique',
         body_kind = 'view_once',
         image_url = null,
         document_url = null,
         document_name = null,
         document_mime = null,
         document_size_bytes = null,
         archive_body = null
   where id = new.id;

  return new;
end;
$$;

drop trigger if exists aegis_stage_view_once_payload on public.messages;
create constraint trigger aegis_stage_view_once_payload
  after insert on public.messages
  deferrable initially deferred
  for each row
  when (new.view_once is true)
  execute function public.stage_aegis_view_once_payload();

create or replace function public.begin_aegis_view_once_consume(
  p_message_id uuid,
  p_device_id text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_message record;
  v_payload record;
  v_copy jsonb;
  v_token uuid;
  v_expires timestamptz;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_message_id is null or length(trim(coalesce(p_device_id, ''))) < 8 then
    raise exception 'AEGIS_VIEW_ONCE_DEVICE_REQUIRED' using errcode = '22023';
  end if;

  select id, conversation_id, sender_id, view_once
    into v_message
    from public.messages
   where id = p_message_id;

  if not found or v_message.view_once is not true then
    return jsonb_build_object('state', 'not_found');
  end if;
  if v_message.sender_id = v_uid then
    return jsonb_build_object('state', 'sender');
  end if;
  if not exists (
    select 1 from public.conversation_participants participant
     where participant.conversation_id = v_message.conversation_id
       and participant.user_id = v_uid
  ) then
    raise exception 'AEGIS_VIEW_ONCE_NOT_PARTICIPANT' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.get_sesame_device_list(v_uid) device
     where device.device_id = trim(p_device_id)
       and device.is_routable = true
  ) then
    raise exception 'AEGIS_VIEW_ONCE_DEVICE_NOT_AUTHORIZED' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.aegis_view_once_consumptions consumed
     where consumed.message_id = p_message_id
       and consumed.user_id = v_uid
  ) then
    return jsonb_build_object('state', 'consumed');
  end if;

  select *
    into v_payload
    from public.aegis_view_once_payloads payload
   where payload.message_id = p_message_id
     and payload.recipient_user_id = v_uid
   for update;

  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;

  select item
    into v_copy
    from jsonb_array_elements(v_payload.device_copies) item
   where item->>'recipient_device_id' = trim(p_device_id)
   limit 1;

  if v_copy is null then
    raise exception 'AEGIS_VIEW_ONCE_DEVICE_COPY_MISSING' using errcode = '42501';
  end if;

  if v_payload.claim_token is not null
     and v_payload.claim_expires_at > now()
     and v_payload.claimed_device_id is distinct from trim(p_device_id) then
    return jsonb_build_object('state', 'claimed_elsewhere');
  end if;

  if v_payload.claim_token is not null
     and v_payload.claim_expires_at > now()
     and v_payload.claimed_device_id = trim(p_device_id) then
    v_token := v_payload.claim_token;
    v_expires := v_payload.claim_expires_at;
  else
    v_token := gen_random_uuid();
    v_expires := now() + interval '5 minutes';
    update public.aegis_view_once_payloads
       set claim_token = v_token,
           claimed_device_id = trim(p_device_id),
           claim_expires_at = v_expires
     where message_id = p_message_id
       and recipient_user_id = v_uid;
  end if;

  return jsonb_build_object(
    'state', 'claimed',
    'protocol', 'aegis-view-once-v1',
    'message_id', p_message_id,
    'conversation_id', v_payload.conversation_id,
    'sender_user_id', v_payload.sender_user_id,
    'sender_device_id', v_copy->>'sender_device_id',
    'claim_token', v_token,
    'claim_expires_at', v_expires,
    'parent_body', v_payload.parent_body,
    'image_url', v_payload.image_url,
    'encrypted_body', v_copy->>'encrypted_body'
  );
end;
$$;

create or replace function public.commit_aegis_view_once_consume(
  p_message_id uuid,
  p_device_id text,
  p_claim_token uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_existing_token uuid;
  v_payload record;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_message_id is null or p_claim_token is null or length(trim(coalesce(p_device_id, ''))) < 8 then
    raise exception 'AEGIS_VIEW_ONCE_COMMIT_INVALID' using errcode = '22023';
  end if;

  select consumed.claim_token
    into v_existing_token
    from public.aegis_view_once_consumptions consumed
   where consumed.message_id = p_message_id
     and consumed.user_id = v_uid;

  if found then
    if v_existing_token = p_claim_token then
      return jsonb_build_object(
        'state', 'committed',
        'protocol', 'aegis-view-once-v1',
        'message_id', p_message_id,
        'claim_token', p_claim_token,
        'existing', true
      );
    end if;
    raise exception 'AEGIS_VIEW_ONCE_ALREADY_CONSUMED' using errcode = '23505';
  end if;

  select *
    into v_payload
    from public.aegis_view_once_payloads payload
   where payload.message_id = p_message_id
     and payload.recipient_user_id = v_uid
   for update;

  if not found
     or v_payload.claim_token is distinct from p_claim_token
     or v_payload.claimed_device_id is distinct from trim(p_device_id)
     or v_payload.claim_expires_at <= now() then
    raise exception 'AEGIS_VIEW_ONCE_CLAIM_INVALID' using errcode = '40001';
  end if;

  insert into public.aegis_view_once_consumptions (
    message_id, user_id, device_id, claim_token
  ) values (
    p_message_id, v_uid, trim(p_device_id), p_claim_token
  );

  delete from public.aegis_view_once_payloads
   where message_id = p_message_id
     and recipient_user_id = v_uid;

  return jsonb_build_object(
    'state', 'committed',
    'protocol', 'aegis-view-once-v1',
    'message_id', p_message_id,
    'claim_token', p_claim_token,
    'existing', false
  );
end;
$$;

create or replace function public.release_aegis_view_once_claim(
  p_message_id uuid,
  p_device_id text,
  p_claim_token uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  update public.aegis_view_once_payloads
     set claim_token = null,
         claimed_device_id = null,
         claim_expires_at = null
   where message_id = p_message_id
     and recipient_user_id = v_uid
     and claim_token = p_claim_token
     and claimed_device_id = trim(p_device_id);
  return found;
end;
$$;

create or replace function public.delete_aegis_message_for_me(
  p_message_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_conversation_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select message.conversation_id
    into v_conversation_id
    from public.messages message
   where message.id = p_message_id;
  if not found or not exists (
    select 1 from public.conversation_participants participant
     where participant.conversation_id = v_conversation_id
       and participant.user_id = v_uid
  ) then
    raise exception 'MESSAGE_DELETE_NOT_ALLOWED' using errcode = '42501';
  end if;

  insert into public.message_deletions (message_id, user_id)
  values (p_message_id, v_uid)
  on conflict (message_id, user_id) do nothing;

  delete from public.aegis_view_once_payloads
   where message_id = p_message_id and recipient_user_id = v_uid;
  delete from public.aegis_view_once_consumptions
   where message_id = p_message_id and user_id = v_uid;
  delete from public.message_archives
   where message_id = p_message_id and user_id = v_uid;
  return true;
end;
$$;

create or replace function public.delete_aegis_message_for_everyone(
  p_message_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_sender uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select message.sender_id
    into v_sender
    from public.messages message
   where message.id = p_message_id
   for update;
  if not found or v_sender is distinct from v_uid then
    raise exception 'MESSAGE_DELETE_NOT_ALLOWED' using errcode = '42501';
  end if;
  delete from public.message_archives where message_id = p_message_id;
  delete from public.messages where id = p_message_id;
  return true;
end;
$$;

revoke all on function public.begin_aegis_view_once_consume(uuid, text) from public, anon;
revoke all on function public.commit_aegis_view_once_consume(uuid, text, uuid) from public, anon;
revoke all on function public.release_aegis_view_once_claim(uuid, text, uuid) from public, anon;
revoke all on function public.delete_aegis_message_for_me(uuid) from public, anon;
revoke all on function public.delete_aegis_message_for_everyone(uuid) from public, anon;

grant execute on function public.begin_aegis_view_once_consume(uuid, text) to authenticated;
grant execute on function public.commit_aegis_view_once_consume(uuid, text, uuid) to authenticated;
grant execute on function public.release_aegis_view_once_claim(uuid, text, uuid) to authenticated;
grant execute on function public.delete_aegis_message_for_me(uuid) to authenticated;
grant execute on function public.delete_aegis_message_for_everyone(uuid) to authenticated;

comment on table public.aegis_view_once_payloads is
  'Sealed per-recipient view-once parent and device capsules; no direct client access.';
comment on function public.commit_aegis_view_once_consume(uuid, text, uuid) is
  'Authoritatively records one consumption and cryptographically erases the recipient payload.';

do $$
begin
  alter publication supabase_realtime add table public.aegis_view_once_consumptions;
exception
  when duplicate_object then null;
  when undefined_object then null;
end;
$$;

notify pgrst, 'reload schema';

commit;

