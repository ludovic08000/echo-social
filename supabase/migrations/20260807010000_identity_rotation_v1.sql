begin;

-- Account identity rotation v1.
--
-- Security model:
--   * a JWT alone is never sufficient;
--   * the current account Ed25519 key signs the server challenge;
--   * one active, approved device signs the same challenge;
--   * the proposed account Ed25519 key self-signs its public binding;
--   * only the authorizing device survives the rotation. Every other device is
--     revoked because it does not yet possess the new account private key.
--
-- Signature verification happens in the identity-rotation Edge Function. The
-- service-role-only functions below enforce state, epoch and atomicity.

alter table public.user_public_keys
  add column if not exists identity_epoch integer not null default 1;

alter table public.user_devices
  add column if not exists identity_epoch integer not null default 1;

alter table public.user_sender_certificates
  add column if not exists revoked_at timestamptz,
  add column if not exists revocation_reason text;

create table if not exists public.user_identity_epochs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  epoch integer not null,
  identity_key text,
  signing_key text,
  fingerprint text not null,
  binding_signature text,
  binding_version integer not null default 1,
  previous_fingerprint text,
  continuity_signature text,
  approver_device_id text,
  approver_signature text,
  reason text not null default 'initial',
  created_at timestamptz not null default clock_timestamp(),
  unique (user_id, epoch)
);

alter table public.user_identity_epochs
  add column if not exists identity_key text,
  add column if not exists signing_key text,
  add column if not exists binding_signature text,
  add column if not exists binding_version integer not null default 1,
  add column if not exists previous_fingerprint text,
  add column if not exists continuity_signature text,
  add column if not exists approver_device_id text,
  add column if not exists approver_signature text;

create table if not exists public.identity_rotation_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  current_epoch integer not null,
  next_epoch integer not null,
  current_fingerprint text not null,
  proposed_identity_key text not null,
  proposed_signing_key text not null,
  proposed_fingerprint text not null,
  proposed_binding_signature text not null,
  proposed_binding_version integer not null default 1,
  approver_device_id text not null,
  reason text not null,
  nonce text not null unique,
  challenge_payload text not null,
  expires_at timestamptz not null,
  committed_at timestamptz,
  cancelled_at timestamptz,
  old_identity_signature text,
  approver_signature text,
  current_device_authorization_signature text,
  created_at timestamptz not null default clock_timestamp(),
  constraint identity_rotation_epoch_step check (next_epoch = current_epoch + 1),
  constraint identity_rotation_binding_version check (proposed_binding_version = 1),
  constraint identity_rotation_terminal_state check (
    not (committed_at is not null and cancelled_at is not null)
  )
);

create index if not exists identity_rotation_requests_user_created_idx
  on public.identity_rotation_requests(user_id, created_at desc);

create unique index if not exists identity_rotation_requests_one_pending_idx
  on public.identity_rotation_requests(user_id)
  where committed_at is null and cancelled_at is null;

alter table public.identity_rotation_requests enable row level security;
alter table public.user_identity_epochs enable row level security;

revoke all on table public.identity_rotation_requests from public, anon, authenticated;
revoke all on table public.user_identity_epochs from anon, authenticated;

-- Snapshot the currently active public identity into epoch 1 when the historical
-- schema predates explicit epoch records.
insert into public.user_identity_epochs (
  user_id,
  epoch,
  identity_key,
  signing_key,
  fingerprint,
  binding_signature,
  binding_version,
  reason,
  created_at
)
select
  key.user_id,
  key.identity_epoch,
  key.identity_key,
  key.signing_key,
  key.fingerprint,
  key.identity_binding_signature,
  coalesce(key.identity_binding_version, 1),
  'pre_rotation_snapshot',
  key.created_at
from public.user_public_keys key
where key.is_active = true
on conflict (user_id, epoch) do nothing;

create or replace function public.begin_identity_rotation_v1(
  p_user_id uuid,
  p_current_epoch integer,
  p_current_fingerprint text,
  p_proposed_identity_key text,
  p_proposed_signing_key text,
  p_proposed_fingerprint text,
  p_proposed_binding_signature text,
  p_approver_device_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_current public.user_public_keys%rowtype;
  v_request_id uuid := gen_random_uuid();
  v_nonce text := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  v_expires_at timestamptz := clock_timestamp() + interval '10 minutes';
  v_reason text := left(coalesce(nullif(trim(p_reason), ''), 'manual_rotation'), 120);
  v_payload text;
begin
  if p_user_id is null then
    raise exception 'identity_rotation_user_required';
  end if;
  if p_current_epoch < 1 then
    raise exception 'identity_rotation_current_epoch_invalid';
  end if;
  if octet_length(coalesce(p_current_fingerprint, '')) < 20
     or octet_length(coalesce(p_current_fingerprint, '')) > 160
     or octet_length(coalesce(p_proposed_fingerprint, '')) < 20
     or octet_length(coalesce(p_proposed_fingerprint, '')) > 160 then
    raise exception 'identity_rotation_fingerprint_invalid';
  end if;
  if octet_length(coalesce(p_proposed_identity_key, '')) < 40
     or octet_length(p_proposed_identity_key) > 128
     or octet_length(coalesce(p_proposed_signing_key, '')) < 40
     or octet_length(p_proposed_signing_key) > 128
     or octet_length(coalesce(p_proposed_binding_signature, '')) < 80
     or octet_length(p_proposed_binding_signature) > 256 then
    raise exception 'identity_rotation_public_bundle_invalid';
  end if;
  if p_proposed_fingerprint = p_current_fingerprint then
    raise exception 'identity_rotation_fingerprint_unchanged';
  end if;

  select key.*
    into v_current
    from public.user_public_keys key
   where key.user_id = p_user_id
     and key.is_active = true
   order by key.created_at desc
   limit 1
   for update;

  if not found then
    raise exception 'identity_rotation_current_identity_not_found';
  end if;
  if v_current.identity_epoch <> p_current_epoch
     or v_current.fingerprint <> p_current_fingerprint then
    raise exception 'identity_rotation_current_identity_changed';
  end if;

  if not exists (
    select 1
      from public.user_devices device
     where device.user_id = p_user_id
       and device.device_id = p_approver_device_id
       and device.approval_status = 'approved'
       and device.is_active = true
       and device.revoked_at is null
       and device.crypto_invalid_at is null
       and device.device_signing_key is not null
  ) then
    raise exception 'identity_rotation_approver_not_trusted';
  end if;

  update public.identity_rotation_requests request
     set cancelled_at = clock_timestamp()
   where request.user_id = p_user_id
     and request.committed_at is null
     and request.cancelled_at is null;

  v_payload := jsonb_build_object(
    'protocol', 'forsure-aegis-identity-rotation',
    'version', 1,
    'rotationId', v_request_id,
    'userId', p_user_id,
    'currentEpoch', p_current_epoch,
    'nextEpoch', p_current_epoch + 1,
    'currentFingerprint', p_current_fingerprint,
    'nextFingerprint', p_proposed_fingerprint,
    'nextIdentityKey', p_proposed_identity_key,
    'nextSigningKey', p_proposed_signing_key,
    'approverDeviceId', p_approver_device_id,
    'nonce', v_nonce,
    'expiresAt', v_expires_at,
    'reason', v_reason
  )::text;

  insert into public.identity_rotation_requests (
    id,
    user_id,
    current_epoch,
    next_epoch,
    current_fingerprint,
    proposed_identity_key,
    proposed_signing_key,
    proposed_fingerprint,
    proposed_binding_signature,
    proposed_binding_version,
    approver_device_id,
    reason,
    nonce,
    challenge_payload,
    expires_at
  ) values (
    v_request_id,
    p_user_id,
    p_current_epoch,
    p_current_epoch + 1,
    p_current_fingerprint,
    p_proposed_identity_key,
    p_proposed_signing_key,
    p_proposed_fingerprint,
    p_proposed_binding_signature,
    1,
    p_approver_device_id,
    v_reason,
    v_nonce,
    v_payload,
    v_expires_at
  );

  return jsonb_build_object(
    'ok', true,
    'code', 'IDENTITY_ROTATION_CHALLENGE_CREATED',
    'rotation_id', v_request_id,
    'current_epoch', p_current_epoch,
    'next_epoch', p_current_epoch + 1,
    'challenge_payload', v_payload,
    'expires_at', v_expires_at
  );
end;
$$;

create or replace function public.commit_identity_rotation_v1(
  p_user_id uuid,
  p_rotation_id uuid,
  p_approver_device_id text,
  p_old_identity_signature text,
  p_approver_signature text,
  p_current_device_authorization_signature text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.identity_rotation_requests%rowtype;
  v_current public.user_public_keys%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  select request.*
    into v_request
    from public.identity_rotation_requests request
   where request.id = p_rotation_id
     and request.user_id = p_user_id
   for update;

  if not found then
    raise exception 'identity_rotation_request_not_found';
  end if;
  if v_request.committed_at is not null then
    return jsonb_build_object(
      'ok', true,
      'code', 'IDENTITY_ROTATION_ALREADY_COMMITTED',
      'rotation_id', v_request.id,
      'identity_epoch', v_request.next_epoch,
      'fingerprint', v_request.proposed_fingerprint
    );
  end if;
  if v_request.cancelled_at is not null then
    raise exception 'identity_rotation_cancelled';
  end if;
  if v_request.expires_at <= v_now then
    raise exception 'identity_rotation_expired';
  end if;
  if v_request.approver_device_id <> p_approver_device_id then
    raise exception 'identity_rotation_approver_changed';
  end if;
  if octet_length(coalesce(p_old_identity_signature, '')) < 80
     or octet_length(coalesce(p_approver_signature, '')) < 80
     or octet_length(coalesce(p_current_device_authorization_signature, '')) < 80 then
    raise exception 'identity_rotation_verified_signatures_required';
  end if;

  select key.*
    into v_current
    from public.user_public_keys key
   where key.user_id = p_user_id
     and key.is_active = true
   order by key.created_at desc
   limit 1
   for update;

  if not found
     or v_current.identity_epoch <> v_request.current_epoch
     or v_current.fingerprint <> v_request.current_fingerprint then
    raise exception 'identity_rotation_current_identity_changed';
  end if;

  if not exists (
    select 1
      from public.user_devices device
     where device.user_id = p_user_id
       and device.device_id = p_approver_device_id
       and device.approval_status = 'approved'
       and device.is_active = true
       and device.revoked_at is null
       and device.crypto_invalid_at is null
       and device.device_signing_key is not null
  ) then
    raise exception 'identity_rotation_approver_not_trusted';
  end if;

  insert into public.user_identity_epochs (
    user_id,
    epoch,
    identity_key,
    signing_key,
    fingerprint,
    binding_signature,
    binding_version,
    reason,
    created_at
  ) values (
    p_user_id,
    v_request.current_epoch,
    v_current.identity_key,
    v_current.signing_key,
    v_current.fingerprint,
    v_current.identity_binding_signature,
    coalesce(v_current.identity_binding_version, 1),
    'pre_rotation_snapshot',
    v_current.created_at
  )
  on conflict (user_id, epoch) do update
  set identity_key = excluded.identity_key,
      signing_key = excluded.signing_key,
      fingerprint = excluded.fingerprint,
      binding_signature = excluded.binding_signature,
      binding_version = excluded.binding_version;

  insert into public.user_identity_epochs (
    user_id,
    epoch,
    identity_key,
    signing_key,
    fingerprint,
    binding_signature,
    binding_version,
    previous_fingerprint,
    continuity_signature,
    approver_device_id,
    approver_signature,
    reason,
    created_at
  ) values (
    p_user_id,
    v_request.next_epoch,
    v_request.proposed_identity_key,
    v_request.proposed_signing_key,
    v_request.proposed_fingerprint,
    v_request.proposed_binding_signature,
    v_request.proposed_binding_version,
    v_request.current_fingerprint,
    p_old_identity_signature,
    p_approver_device_id,
    p_approver_signature,
    v_request.reason,
    v_now
  );

  -- The table historically allowed either one row per account or multiple
  -- rows. Updating the active row in place is compatible with both layouts.
  update public.user_public_keys
     set identity_key = v_request.proposed_identity_key,
         signing_key = v_request.proposed_signing_key,
         fingerprint = v_request.proposed_fingerprint,
         identity_binding_signature = v_request.proposed_binding_signature,
         identity_binding_version = v_request.proposed_binding_version,
         identity_epoch = v_request.next_epoch,
         is_active = true,
         updated_at = v_now
   where id = v_current.id;

  update public.user_public_keys
     set is_active = false,
         updated_at = v_now
   where user_id = p_user_id
     and id <> v_current.id
     and is_active = true;

  -- The authorizing installation is the only device that can prove possession
  -- of the new account private key at commit time.
  update public.user_devices
     set device_authorization_signature = p_current_device_authorization_signature,
         identity_epoch = v_request.next_epoch,
         approval_status = 'approved',
         is_active = true,
         revoked_at = null,
         rejected_at = null,
         rejected_by = null,
         revoke_reason = null,
         crypto_invalid_at = null,
         crypto_invalid_reason = null,
         routing_status = 'active',
         prekey_repair_requested_at = v_now,
         updated_at = v_now
   where user_id = p_user_id
     and device_id = p_approver_device_id;

  -- Every other installation is revoked atomically. Retaining it would leave a
  -- device active without possession of the new account identity private key.
  update public.user_devices
     set identity_epoch = v_request.next_epoch,
         is_active = false,
         approval_status = 'rejected',
         revoked_at = coalesce(revoked_at, v_now),
         rejected_at = coalesce(rejected_at, v_now),
         rejected_by = p_approver_device_id,
         revoke_reason = 'account_identity_rotated',
         routing_status = 'revoked',
         crypto_invalid_at = coalesce(crypto_invalid_at, v_now),
         crypto_invalid_reason = 'account_identity_rotated',
         updated_at = v_now
   where user_id = p_user_id
     and device_id <> p_approver_device_id
     and (is_active = true or revoked_at is null);

  update public.user_sender_certificates
     set revoked_at = coalesce(revoked_at, v_now),
         revocation_reason = 'account_identity_rotated'
   where user_id = p_user_id
     and identity_epoch < v_request.next_epoch
     and revoked_at is null;

  -- Existing device SPKs remain cryptographically tied to the surviving
  -- device signing key, but the client is required to refresh them and all
  -- active ratchets after promotion of the new account identity.

  insert into public.e2ee_transparency_log (
    user_id,
    event_type,
    fingerprint,
    identity_epoch,
    device_id,
    payload,
    created_at
  ) values (
    p_user_id,
    'identity_rotated',
    v_request.proposed_fingerprint,
    v_request.next_epoch,
    p_approver_device_id,
    jsonb_build_object(
      'previous_fingerprint', v_request.current_fingerprint,
      'rotation_id', v_request.id,
      'reason', v_request.reason,
      'other_devices_revoked', true
    ),
    v_now
  );

  -- Proactively surface the safety-number change to existing peers. The
  -- observer still has to acknowledge it in the client.
  insert into public.user_identity_change_events (
    observer_user_id,
    peer_user_id,
    previous_fingerprint,
    new_fingerprint,
    change_type,
    observed_at,
    acknowledged
  )
  select distinct
    peer.user_id,
    p_user_id,
    v_request.current_fingerprint,
    v_request.proposed_fingerprint,
    'verified_rotation',
    v_now,
    false
  from public.conversation_participants mine
  join public.conversation_participants peer
    on peer.conversation_id = mine.conversation_id
   and peer.user_id <> p_user_id
  where mine.user_id = p_user_id
  on conflict do nothing;

  update public.identity_rotation_requests
     set committed_at = v_now,
         old_identity_signature = p_old_identity_signature,
         approver_signature = p_approver_signature,
         current_device_authorization_signature = p_current_device_authorization_signature
   where id = v_request.id;

  return jsonb_build_object(
    'ok', true,
    'code', 'IDENTITY_ROTATION_COMMITTED',
    'rotation_id', v_request.id,
    'identity_epoch', v_request.next_epoch,
    'fingerprint', v_request.proposed_fingerprint,
    'surviving_device_id', p_approver_device_id,
    'other_devices_revoked', true
  );
end;
$$;

create or replace function public.cancel_identity_rotation_v1(
  p_user_id uuid,
  p_rotation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.identity_rotation_requests%rowtype;
begin
  select request.*
    into v_request
    from public.identity_rotation_requests request
   where request.id = p_rotation_id
     and request.user_id = p_user_id
   for update;

  if not found then
    raise exception 'identity_rotation_request_not_found';
  end if;
  if v_request.committed_at is not null then
    raise exception 'identity_rotation_already_committed';
  end if;

  update public.identity_rotation_requests
     set cancelled_at = coalesce(cancelled_at, clock_timestamp())
   where id = v_request.id;

  return jsonb_build_object(
    'ok', true,
    'code', 'IDENTITY_ROTATION_CANCELLED',
    'rotation_id', v_request.id
  );
end;
$$;

create or replace function public.get_identity_rotation_status_v1(
  p_user_id uuid,
  p_rotation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_request public.identity_rotation_requests%rowtype;
begin
  select request.*
    into v_request
    from public.identity_rotation_requests request
   where request.id = p_rotation_id
     and request.user_id = p_user_id;

  if not found then
    raise exception 'identity_rotation_request_not_found';
  end if;

  return jsonb_build_object(
    'ok', true,
    'rotation_id', v_request.id,
    'status', case
      when v_request.committed_at is not null then 'committed'
      when v_request.cancelled_at is not null then 'cancelled'
      when v_request.expires_at <= clock_timestamp() then 'expired'
      else 'pending'
    end,
    'identity_epoch', v_request.next_epoch,
    'fingerprint', v_request.proposed_fingerprint,
    'approver_device_id', v_request.approver_device_id,
    'expires_at', v_request.expires_at
  );
end;
$$;

revoke all on function public.begin_identity_rotation_v1(
  uuid, integer, text, text, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.commit_identity_rotation_v1(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.cancel_identity_rotation_v1(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.get_identity_rotation_status_v1(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.begin_identity_rotation_v1(
  uuid, integer, text, text, text, text, text, text, text
) to service_role;
grant execute on function public.commit_identity_rotation_v1(
  uuid, uuid, text, text, text, text
) to service_role;
grant execute on function public.cancel_identity_rotation_v1(uuid, uuid)
  to service_role;
grant execute on function public.get_identity_rotation_status_v1(uuid, uuid)
  to service_role;

commit;
