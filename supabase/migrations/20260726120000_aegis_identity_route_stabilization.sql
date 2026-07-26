-- Aegis identity and route stabilization.
--
-- Security invariants:
--   * X25519 and Ed25519 are one signed account identity;
--   * device authorization/revocation is distinct from route health;
--   * a send is prepared against one monotonic conversation-route version;
--   * the stable message UUID remains idempotent across route refreshes.

begin;

alter table public.user_public_keys
  add column if not exists identity_binding_version integer,
  add column if not exists identity_binding_signature text;

alter table public.user_devices
  add column if not exists routing_status text not null default 'repairing',
  add column if not exists routing_error text,
  add column if not exists routing_checked_at timestamptz;

alter table public.user_devices
  drop constraint if exists user_devices_routing_status_check;
alter table public.user_devices
  add constraint user_devices_routing_status_check
  check (routing_status in ('ready', 'repairing', 'unavailable'));

alter table public.messages
  add column if not exists aegis_route_version text;

-- Existing authorized devices are routable only when an active SPK exists.
update public.user_devices device
set routing_status = case
      when device.revoked_at is null
       and coalesce(device.approval_status, 'approved') = 'approved'
       and exists (
         select 1
         from public.device_signed_prekeys spk
         where spk.user_id = device.user_id
           and spk.device_id = device.device_id
           and spk.is_active = true
       )
      then 'ready'
      else 'repairing'
    end,
    routing_checked_at = now(),
    routing_error = case
      when exists (
        select 1
        from public.device_signed_prekeys spk
        where spk.user_id = device.user_id
          and spk.device_id = device.device_id
          and spk.is_active = true
      ) then null
      else 'SIGNED_PREKEY_REQUIRED'
    end
where device.revoked_at is null;

create table if not exists public.aegis_user_route_versions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  route_version bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.aegis_user_route_versions enable row level security;
revoke all on table public.aegis_user_route_versions
from public, anon, authenticated;

insert into public.aegis_user_route_versions (user_id, route_version)
select distinct user_id, 1
from public.user_devices
on conflict (user_id) do nothing;

create or replace function public.bump_aegis_user_route_version(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_user_id is null then
    return;
  end if;

  insert into public.aegis_user_route_versions (
    user_id, route_version, updated_at
  )
  values (p_user_id, 1, now())
  on conflict (user_id) do update
  set route_version = public.aegis_user_route_versions.route_version + 1,
      updated_at = now();
end;
$$;

revoke all on function public.bump_aegis_user_route_version(uuid)
from public, anon, authenticated;

create or replace function public.trg_bump_aegis_device_route()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  if tg_op = 'DELETE' then
    v_user_id := old.user_id;
  else
    v_user_id := new.user_id;
  end if;

  if tg_op <> 'UPDATE' or (
    old.device_id,
    old.device_public_key,
    old.is_active,
    old.is_primary,
    old.approval_status,
    old.revoked_at,
    old.routing_status
  ) is distinct from (
    new.device_id,
    new.device_public_key,
    new.is_active,
    new.is_primary,
    new.approval_status,
    new.revoked_at,
    new.routing_status
  ) then
    perform public.bump_aegis_user_route_version(v_user_id);
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists bump_aegis_device_route on public.user_devices;
create trigger bump_aegis_device_route
after insert or update or delete on public.user_devices
for each row execute function public.trg_bump_aegis_device_route();

create or replace function public.trg_bump_aegis_signature_route()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  if tg_op = 'DELETE' then
    v_user_id := old.user_id;
  else
    v_user_id := new.user_id;
  end if;

  perform public.bump_aegis_user_route_version(v_user_id);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists bump_aegis_signature_route
on public.user_device_signatures;
create trigger bump_aegis_signature_route
after insert or update or delete on public.user_device_signatures
for each row execute function public.trg_bump_aegis_signature_route();

drop trigger if exists bump_aegis_signed_prekey_route
on public.device_signed_prekeys;
create trigger bump_aegis_signed_prekey_route
after insert or update or delete on public.device_signed_prekeys
for each row execute function public.trg_bump_aegis_signature_route();

drop trigger if exists bump_aegis_root_route
on public.user_identity_roots;
create trigger bump_aegis_root_route
after insert or update or delete on public.user_identity_roots
for each row execute function public.trg_bump_aegis_signature_route();

drop trigger if exists bump_aegis_public_identity_route
on public.user_public_keys;
create trigger bump_aegis_public_identity_route
after insert or update or delete on public.user_public_keys
for each row execute function public.trg_bump_aegis_signature_route();

-- Route membership means "authorized AND cryptographically ready".
-- Unhealthy devices remain visible in the connected-device menu.
create or replace function public.get_signed_device_list(p_user_id uuid)
returns table (
  device_id text,
  device_public_key text,
  is_primary boolean,
  primary_device_id text,
  primary_pub_b64 text,
  signature_b64 text,
  signed_at timestamptz
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  with authorized_primary as (
    select min(device.device_id) as device_id
    from public.user_devices device
    where device.user_id = p_user_id
      and device.is_active = true
      and coalesce(device.approval_status, 'approved') = 'approved'
      and device.revoked_at is null
      and device.is_primary = true
    having count(*) = 1
  ),
  active_devices as (
    select device.device_id, device.device_public_key, device.is_primary
    from public.user_devices device
    where device.user_id = p_user_id
      and device.is_active = true
      and coalesce(device.approval_status, 'approved') = 'approved'
      and device.revoked_at is null
      and device.routing_status = 'ready'
      and nullif(trim(device.device_public_key), '') is not null
      and exists (
        select 1
        from public.device_signed_prekeys spk
        where spk.user_id = device.user_id
          and spk.device_id = device.device_id
          and spk.is_active = true
      )
  ),
  canonical_root as (
    select root.primary_device_id, root.identity_pub_b64
    from public.user_identity_roots root
    join authorized_primary primary_row
      on primary_row.device_id = root.primary_device_id
    join public.user_public_keys identity
      on identity.user_id = root.user_id
     and identity.is_active = true
     and identity.signing_key = root.identity_pub_b64
     and identity.identity_binding_version = 1
     and nullif(trim(identity.identity_binding_signature), '') is not null
    where root.user_id = p_user_id
      and nullif(trim(root.identity_pub_b64), '') is not null
  ),
  signature_rows as (
    select distinct on (signature.device_id)
      signature.device_id,
      signature.primary_device_id,
      signature.primary_pub_b64,
      signature.signature_b64,
      signature.signed_at
    from public.user_device_signatures signature
    join canonical_root root
      on root.primary_device_id = signature.primary_device_id
     and root.identity_pub_b64 = signature.primary_pub_b64
    where signature.user_id = p_user_id
      and signature.revoked_at is null
      and nullif(trim(signature.signature_b64), '') is not null
    order by signature.device_id, signature.signed_at desc
  )
  select
    device.device_id,
    device.device_public_key,
    device.is_primary,
    case when device.is_primary then null else signature.primary_device_id end,
    root.identity_pub_b64,
    case when device.is_primary then null else signature.signature_b64 end,
    case when device.is_primary then null else signature.signed_at end
  from active_devices device
  cross join canonical_root root
  left join signature_rows signature
    on signature.device_id = device.device_id
  where device.is_primary = true
     or signature.signature_b64 is not null
  order by device.is_primary desc, device.device_id;
$$;

revoke all on function public.get_signed_device_list(uuid)
from public, anon;
grant execute on function public.get_signed_device_list(uuid)
to authenticated;

create or replace function public.get_aegis_conversation_route_version(
  p_conversation_id uuid
)
returns text
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_version text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
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

  select md5(string_agg(
    participant.user_id::text || ':' ||
      coalesce(route.route_version, 0)::text,
    '|' order by participant.user_id
  ))
  into v_version
  from public.conversation_participants participant
  left join public.aegis_user_route_versions route
    on route.user_id = participant.user_id
  where participant.conversation_id = p_conversation_id;

  if v_version is null then
    raise exception 'E2EE_ROUTE_VERSION_UNAVAILABLE'
      using errcode = '23514';
  end if;
  return v_version;
end;
$$;

revoke all on function public.get_aegis_conversation_route_version(uuid)
from public, anon;
grant execute on function public.get_aegis_conversation_route_version(uuid)
to authenticated;

-- Recovery returns the existing ID even when it is revoked or unhealthy.
-- Hiding a revoked row allowed storage loss to mint a replacement route.
create or replace function public.resolve_device_id_by_fingerprints(
  p_fingerprints text[],
  p_platform text default null
)
returns text
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select device.device_id
  from public.user_devices device
  where device.user_id = auth.uid()
    and device.device_fingerprint =
      any(coalesce(p_fingerprints, '{}'::text[]))
    and (p_platform is null or device.platform = p_platform)
  order by
    array_position(p_fingerprints, device.device_fingerprint)
      asc nulls last,
    case
      when device.revoked_at is not null
        or device.approval_status = 'rejected'
      then 0
      else 1
    end,
    device.last_seen_at desc nulls last,
    device.created_at desc
  limit 1;
$$;

revoke all on function public.resolve_device_id_by_fingerprints(text[], text)
from public, anon;
grant execute on function public.resolve_device_id_by_fingerprints(text[], text)
to authenticated;

-- DROP is intentional: PostgreSQL cannot remove old parameter defaults via
-- CREATE OR REPLACE on the existing seven-argument signature.
drop function if exists public.register_user_device_safe(
  uuid, text, text, text, text, text, text
);

create function public.register_user_device_safe(
  p_user_id uuid,
  p_device_id text,
  p_device_name text,
  p_device_public_key text,
  p_device_fingerprint text,
  p_platform text,
  p_user_agent text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_existing public.user_devices%rowtype;
  v_now timestamptz := now();
begin
  if v_uid is null or p_user_id is distinct from v_uid then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  if length(v_device_id) < 8
     or nullif(trim(coalesce(p_device_public_key, '')), '') is null then
    return jsonb_build_object(
      'ok', false, 'code', 'INVALID_DEVICE_PAYLOAD'
    );
  end if;

  select *
  into v_existing
  from public.user_devices
  where user_id = v_uid
    and device_id = v_device_id
  for update;

  if found and (
    v_existing.revoked_at is not null
    or v_existing.approval_status = 'rejected'
  ) then
    return jsonb_build_object(
      'ok', false,
      'code', 'DEVICE_REVOKED_OR_REJECTED',
      'device_id', v_device_id
    );
  end if;

  if found
     and v_existing.device_public_key is distinct from p_device_public_key then
    return jsonb_build_object(
      'ok', false,
      'code', 'DEVICE_KEY_MISMATCH',
      'device_id', v_device_id
    );
  end if;

  insert into public.user_devices (
    user_id, device_id, device_name, device_public_key,
    device_fingerprint, platform, user_agent, is_active,
    last_seen_at, approval_status, approval_requested_at,
    approved_at, approved_by, stale_at, routing_status,
    routing_error, routing_checked_at
  )
  values (
    v_uid, v_device_id, p_device_name, p_device_public_key,
    p_device_fingerprint, p_platform, p_user_agent, true,
    v_now, 'approved', v_now, v_now, v_uid, null,
    'repairing', 'SIGNED_PREKEY_VALIDATION_PENDING', v_now
  )
  on conflict (user_id, device_id) do update
  set device_name = excluded.device_name,
      device_public_key = excluded.device_public_key,
      device_fingerprint = excluded.device_fingerprint,
      platform = excluded.platform,
      user_agent = excluded.user_agent,
      is_active = true,
      last_seen_at = v_now,
      updated_at = v_now,
      approval_status = 'approved',
      approved_at = coalesce(public.user_devices.approved_at, v_now),
      approved_by = coalesce(public.user_devices.approved_by, v_uid),
      stale_at = null,
      routing_status = case
        when public.user_devices.device_public_key =
          excluded.device_public_key
         and public.user_devices.routing_status = 'ready'
        then 'ready'
        else 'repairing'
      end,
      routing_error = case
        when public.user_devices.device_public_key =
          excluded.device_public_key
         and public.user_devices.routing_status = 'ready'
        then null
        else 'SIGNED_PREKEY_VALIDATION_PENDING'
      end,
      routing_checked_at = v_now
  where public.user_devices.revoked_at is null
    and coalesce(public.user_devices.approval_status, 'approved')
      <> 'rejected';

  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'DEVICE_REVOKED_OR_REJECTED'
    );
  end if;

  perform public.ensure_primary_device_exists(v_uid);
  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_REGISTERED_AND_APPROVED',
    'status', 'approved',
    'routing_status', (
      select routing_status
      from public.user_devices
      where user_id = v_uid
        and device_id = v_device_id
    ),
    'device_id', v_device_id
  );
end;
$$;

revoke all on function public.register_user_device_safe(
  uuid, text, text, text, text, text, text
) from public, anon;
grant execute on function public.register_user_device_safe(
  uuid, text, text, text, text, text, text
) to authenticated;

create or replace function public.mark_current_device_route_ready(
  p_device_id text
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
    from public.device_signed_prekeys spk
    where spk.user_id = v_uid
      and spk.device_id = v_device_id
      and spk.is_active = true
  ) then
    update public.user_devices
    set routing_status = 'repairing',
        routing_error = 'SIGNED_PREKEY_REQUIRED',
        routing_checked_at = now()
    where user_id = v_uid
      and device_id = v_device_id
      and revoked_at is null;
    return jsonb_build_object(
      'ok', false, 'code', 'SIGNED_PREKEY_REQUIRED'
    );
  end if;

  update public.user_devices
  set routing_status = 'ready',
      routing_error = null,
      routing_checked_at = now()
  where user_id = v_uid
    and device_id = v_device_id
    and is_active = true
    and revoked_at is null
    and coalesce(approval_status, 'approved') = 'approved';

  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'DEVICE_NOT_AUTHORIZED'
    );
  end if;
  return jsonb_build_object('ok', true, 'code', 'DEVICE_ROUTE_READY');
end;
$$;

revoke all on function public.mark_current_device_route_ready(text)
from public, anon;
grant execute on function public.mark_current_device_route_ready(text)
to authenticated;

create or replace function public.mark_current_device_route_unavailable(
  p_device_id text,
  p_error_code text
)
returns jsonb
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

  update public.user_devices
  set routing_status = 'unavailable',
      routing_error = left(
        coalesce(nullif(trim(p_error_code), ''), 'UNKNOWN'),
        120
      ),
      routing_checked_at = now(),
      updated_at = now()
  where user_id = v_uid
    and device_id = p_device_id
    and revoked_at is null;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_ACTIVE');
  end if;
  return jsonb_build_object(
    'ok', true, 'routing_status', 'unavailable'
  );
end;
$$;

revoke all on function public.mark_current_device_route_unavailable(text, text)
from public, anon;
grant execute on function public.mark_current_device_route_unavailable(text, text)
to authenticated;

-- SPK quarantine changes health, never authorization/revocation.
create or replace function public.quarantine_own_invalid_device_spk(
  p_device_id text,
  p_spk_id integer,
  p_reason text default 'invalid_device_spk_signature'
)
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

  update public.device_signed_prekeys
  set is_active = false,
      is_last_resort = false
  where user_id = v_uid
    and device_id = trim(p_device_id)
    and (
      spk_id = p_spk_id
      or is_active = true
      or is_last_resort = true
    );

  update public.user_devices
  set routing_status = 'repairing',
      routing_error = left(
        coalesce(p_reason, 'INVALID_SIGNED_PREKEY'),
        200
      ),
      routing_checked_at = now()
  where user_id = v_uid
    and device_id = trim(p_device_id)
    and revoked_at is null;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_SPK_REPAIR_REQUIRED',
    'device_id', trim(p_device_id)
  );
end;
$$;

drop trigger if exists aegis_require_exact_device_copies
on public.messages;
drop function if exists public.trg_aegis_require_exact_device_copies();
drop trigger if exists aegis_require_all_device_copies
on public.message_device_copies;
drop function if exists public.trg_aegis_require_all_device_copies();

drop function if exists public.aegis_send_message(
  uuid, uuid, text, text, jsonb, jsonb, text
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
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_existing_sender uuid;
  v_existing_conversation uuid;
  v_existing_body text;
  v_current_route_version text;
  v_copies jsonb := coalesce(p_copies, '[]'::jsonb);
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

  if not exists (
    select 1
    from public.conversation_participants participant
    where participant.conversation_id = p_conversation_id
      and participant.user_id = v_uid
  ) then
    raise exception 'sender_not_conversation_participant'
      using errcode = '42501';
  end if;

  -- Confirmation with the stable UUID precedes current-route validation.
  select message.sender_id, message.conversation_id, message.body
  into v_existing_sender, v_existing_conversation, v_existing_body
  from public.messages message
  where message.id = p_message_id;

  if found then
    if v_existing_sender = v_uid
       and v_existing_conversation = p_conversation_id
       and v_existing_body = p_body then
      return p_message_id;
    end if;
    raise exception 'MESSAGE_ID_CONFLICT' using errcode = '23505';
  end if;

  if not public.is_supported_aegis_message(p_body, 'multi_device') then
    raise exception 'AEGIS_WIRE_FORMAT_REJECTED' using errcode = '23514';
  end if;
  if length(trim(coalesce(p_sender_device_id, ''))) < 8 then
    raise exception 'E2EE_SENDER_DEVICE_REQUIRED' using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.get_signed_device_list(v_uid) own_device
    where own_device.device_id = p_sender_device_id
  ) then
    raise exception 'E2EE_SENDER_DEVICE_NOT_TRUSTED'
      using errcode = '23514';
  end if;

  -- Lock every participant route-counter for the rest of the transaction.
  -- Route mutation triggers update these rows and therefore cannot commit
  -- between version validation and capsule insertion.
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

  if jsonb_typeof(v_copies) <> 'array' then
    raise exception 'E2EE_INVALID_DEVICE_COPY' using errcode = '23514';
  end if;

  with supplied as (
    select *
    from jsonb_to_recordset(v_copies) as copy(
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
    from jsonb_to_recordset(v_copies) as copy(
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
     or copy.sender_device_id is distinct from p_sender_device_id
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
    from public.get_signed_device_list(peer.user_id)
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
    cross join lateral
      public.get_signed_device_list(participant.user_id) device
    where participant.conversation_id = p_conversation_id
      and not (
        participant.user_id = v_uid
        and device.device_id = p_sender_device_id
      )
  ),
  supplied as (
    select *
    from jsonb_to_recordset(v_copies) as copy(
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
    document_size_bytes, archive_body, aegis_route_version
  )
  values (
    p_message_id,
    p_conversation_id,
    v_uid,
    p_body,
    nullif(p_image_url, ''),
    'multi_device',
    coalesce(
      (coalesce(p_extra, '{}'::jsonb)->>'view_once')::boolean,
      false
    ),
    nullif(
      coalesce(p_extra, '{}'::jsonb)->>'expires_at',
      ''
    )::timestamptz,
    nullif(coalesce(p_extra, '{}'::jsonb)->>'document_url', ''),
    nullif(coalesce(p_extra, '{}'::jsonb)->>'document_name', ''),
    nullif(coalesce(p_extra, '{}'::jsonb)->>'document_mime', ''),
    nullif(
      coalesce(p_extra, '{}'::jsonb)->>'document_size_bytes',
      ''
    )::integer,
    nullif(coalesce(p_extra, '{}'::jsonb)->>'archive_body', ''),
    p_route_version
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
  from jsonb_to_recordset(v_copies) as copy(
    recipient_user_id uuid,
    recipient_device_id text,
    sender_device_id text,
    encrypted_body text
  );

  return p_message_id;
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
) is 'Aegis atomic send pinned to one monotonic conversation route version.';

-- Defence in depth for any direct parent insert. The deferred trigger sees
-- the complete capsule set after the RPC has inserted parent and copies.
create or replace function public.trg_aegis_require_pinned_device_copies()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sender_device_id text;
  v_current_route_version text;
  v_missing_count integer := 0;
  v_unexpected_count integer := 0;
  v_duplicate_count integer := 0;
begin
  if new.body_kind <> 'multi_device' then
    return null;
  end if;

  v_current_route_version :=
    public.get_aegis_conversation_route_version(new.conversation_id);
  if new.aegis_route_version is null
     or new.aegis_route_version is distinct from v_current_route_version then
    raise exception 'E2EE_DEVICE_LIST_STALE'
      using errcode = '23514',
            detail =
              'Aegis parent is not pinned to the current route version.';
  end if;

  select min(copy.sender_device_id)
  into v_sender_device_id
  from public.message_device_copies copy
  where copy.message_id = new.id
    and copy.sender_user_id = new.sender_id;

  if v_sender_device_id is null
     or length(trim(v_sender_device_id)) < 8 then
    raise exception 'E2EE_DEVICE_COPIES_UNAVAILABLE'
      using errcode = '23514',
            detail = 'Aegis parent has no sender-bound device copy set.';
  end if;

  select
    count(*) -
      count(distinct (copy.recipient_user_id, copy.recipient_device_id))
  into v_duplicate_count
  from public.message_device_copies copy
  where copy.message_id = new.id;

  with expected as (
    select distinct
      participant.user_id as recipient_user_id,
      device.device_id as recipient_device_id
    from public.conversation_participants participant
    cross join lateral
      public.get_signed_device_list(participant.user_id) device
    where participant.conversation_id = new.conversation_id
      and not (
        participant.user_id = new.sender_id
        and device.device_id = v_sender_device_id
      )
  )
  select count(*)
  into v_missing_count
  from expected route
  where not exists (
    select 1
    from public.message_device_copies actual
    where actual.message_id = new.id
      and actual.recipient_user_id = route.recipient_user_id
      and actual.recipient_device_id = route.recipient_device_id
      and actual.sender_user_id = new.sender_id
      and actual.sender_device_id = v_sender_device_id
  );

  with expected as (
    select distinct
      participant.user_id as recipient_user_id,
      device.device_id as recipient_device_id
    from public.conversation_participants participant
    cross join lateral
      public.get_signed_device_list(participant.user_id) device
    where participant.conversation_id = new.conversation_id
      and not (
        participant.user_id = new.sender_id
        and device.device_id = v_sender_device_id
      )
  )
  select count(*)
  into v_unexpected_count
  from public.message_device_copies actual
  where actual.message_id = new.id
    and (
      actual.sender_user_id <> new.sender_id
      or actual.sender_device_id <> v_sender_device_id
      or not exists (
        select 1
        from expected route
        where route.recipient_user_id = actual.recipient_user_id
          and route.recipient_device_id = actual.recipient_device_id
      )
    );

  if v_missing_count > 0
     or v_unexpected_count > 0
     or v_duplicate_count > 0 then
    raise exception 'E2EE_DEVICE_LIST_STALE'
      using errcode = '23514',
            detail = format(
              'Pinned Aegis route mismatch: %s missing, %s unexpected, %s duplicate.',
              v_missing_count,
              v_unexpected_count,
              v_duplicate_count
            );
  end if;
  return null;
end;
$$;

revoke all on function public.trg_aegis_require_pinned_device_copies()
from public, anon, authenticated;

drop trigger if exists aegis_require_pinned_device_copies
on public.messages;

create constraint trigger aegis_require_pinned_device_copies
after insert on public.messages
deferrable initially deferred
for each row
execute function public.trg_aegis_require_pinned_device_copies();

commit;
