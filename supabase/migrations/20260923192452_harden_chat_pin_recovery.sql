begin;

-- This migration is intentionally additive. Existing clients keep using the
-- current PIN gate while the new email-reset transaction is introduced and
-- tested. No message, identity, device, prekey or Libsignal table is mutated.

alter table public.aegis_pin_continuity_vault
  add column if not exists generation bigint not null default 1;

do $constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'aegis_pin_continuity_generation_positive'
      and conrelid = 'public.aegis_pin_continuity_vault'::regclass
  ) then
    alter table public.aegis_pin_continuity_vault
      add constraint aegis_pin_continuity_generation_positive
      check (generation > 0);
  end if;
end;
$constraints$;

-- Existing clients use this RPC only after proving that no continuity row is
-- present. Make that invariant enforceable in PostgreSQL: an authenticated
-- session may create its first envelope, but it can never overwrite an
-- existing generation. PIN replacement belongs exclusively to the atomic
-- reset transaction below.
create or replace function public.aegis_pin_continuity_upsert(
  p_version integer,
  p_ciphertext text,
  p_iv text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_ciphertext_bytes integer;
  v_iv_bytes integer;
  v_inserted integer;
begin
  if v_uid is null then
    raise exception 'AEGIS_PIN_CONTINUITY_UNAUTHENTICATED'
      using errcode = '42501';
  end if;
  if p_version is distinct from 1 then
    raise exception 'AEGIS_PIN_CONTINUITY_UNSUPPORTED_VERSION'
      using errcode = '22023';
  end if;
  if p_ciphertext is null
     or p_ciphertext !~ '^[A-Za-z0-9+/]+={0,2}$'
     or p_iv is null
     or p_iv !~ '^[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'AEGIS_PIN_CONTINUITY_INVALID_ENVELOPE'
      using errcode = '22023';
  end if;

  begin
    v_ciphertext_bytes := octet_length(decode(p_ciphertext, 'base64'));
    v_iv_bytes := octet_length(decode(p_iv, 'base64'));
  exception when others then
    raise exception 'AEGIS_PIN_CONTINUITY_INVALID_ENVELOPE'
      using errcode = '22023';
  end;

  if v_iv_bytes <> 12
     or v_ciphertext_bytes < 48
     or v_ciphertext_bytes > 6144 then
    raise exception 'AEGIS_PIN_CONTINUITY_INVALID_ENVELOPE'
      using errcode = '22023';
  end if;

  insert into public.aegis_pin_continuity_vault (
    user_id,
    version,
    ciphertext,
    iv,
    generation
  ) values (
    v_uid,
    p_version,
    p_ciphertext,
    p_iv,
    1
  )
  on conflict (user_id) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$function$;

-- The old table remains as a compatibility marker for the deployed Edge
-- Function, but browser sessions must never read or mutate reset state.
alter table public.user_chat_pins enable row level security;
revoke all on table public.user_chat_pins from public, anon, authenticated;
grant all on table public.user_chat_pins to service_role;

drop policy if exists "Users can check own pin exists" on public.user_chat_pins;
drop policy if exists "Users can read own pin id" on public.user_chat_pins;
drop policy if exists "Users can read own pin" on public.user_chat_pins;
drop policy if exists "Users can insert own pin" on public.user_chat_pins;
drop policy if exists "Users can update own pin" on public.user_chat_pins;
drop policy if exists "Users can delete own pin" on public.user_chat_pins;

create table if not exists public.aegis_chat_pin_reset_challenges (
  user_id uuid primary key references auth.users(id) on delete cascade,
  challenge_id uuid not null unique default gen_random_uuid(),
  code_hash text,
  code_salt text,
  code_expires_at timestamptz,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  requested_at timestamptz not null default now(),
  last_sent_at timestamptz,
  burst_window_started_at timestamptz not null default now(),
  burst_request_count integer not null default 1,
  daily_window_started_at timestamptz not null default now(),
  daily_request_count integer not null default 1,
  authorization_hash text,
  authorization_expires_at timestamptz,
  authorized_device_id text,
  authorized_at timestamptz,
  consumed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint aegis_chat_pin_reset_failed_attempts_bounded
    check (failed_attempts between 0 and 5),
  constraint aegis_chat_pin_reset_burst_count_positive
    check (burst_request_count > 0),
  constraint aegis_chat_pin_reset_daily_count_positive
    check (daily_request_count > 0),
  constraint aegis_chat_pin_reset_device_id_bounded
    check (
      authorized_device_id is null
      or length(authorized_device_id) between 8 and 128
    )
);

alter table public.aegis_chat_pin_reset_challenges enable row level security;
revoke all on table public.aegis_chat_pin_reset_challenges
from public, anon, authenticated;
grant all on table public.aegis_chat_pin_reset_challenges to service_role;

create index if not exists idx_aegis_chat_pin_reset_expiry
  on public.aegis_chat_pin_reset_challenges (code_expires_at)
  where consumed_at is null;

create or replace function public.aegis_chat_pin_reset_begin(
  p_user_id uuid,
  p_code_hash text,
  p_code_salt text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.aegis_chat_pin_reset_challenges%rowtype;
  v_challenge_id uuid := gen_random_uuid();
  v_burst_started timestamptz;
  v_burst_count integer;
  v_daily_started timestamptz;
  v_daily_count integer;
  v_retry_after integer;
begin
  if p_user_id is null
     or p_code_hash is null
     or p_code_hash !~ '^[A-Za-z0-9+/]+={0,2}$'
     or length(p_code_hash) not between 40 and 128
     or p_code_salt is null
     or p_code_salt !~ '^[A-Za-z0-9+/]+={0,2}$'
     or length(p_code_salt) not between 20 and 128
     or p_expires_at <= v_now
     or p_expires_at > v_now + interval '15 minutes' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CHALLENGE');
  end if;

  -- Serialize the first request too; FOR UPDATE alone cannot lock a row that
  -- does not exist yet.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  if not exists (
    select 1
    from public.aegis_pin_continuity_vault vault
    where vault.user_id = p_user_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'PIN_NOT_CONFIGURED');
  end if;

  select challenge.*
  into v_row
  from public.aegis_chat_pin_reset_challenges challenge
  where challenge.user_id = p_user_id
  for update;

  if found then
    if v_row.locked_until is not null and v_row.locked_until > v_now then
      v_retry_after := greatest(
        1,
        ceiling(extract(epoch from (v_row.locked_until - v_now)))::integer
      );
      return jsonb_build_object(
        'ok', false,
        'code', 'RATE_LIMITED',
        'retry_after_seconds', v_retry_after
      );
    end if;

    if v_row.last_sent_at is not null
       and v_row.last_sent_at > v_now - interval '60 seconds' then
      v_retry_after := greatest(
        1,
        ceiling(extract(epoch from (
          v_row.last_sent_at + interval '60 seconds' - v_now
        )))::integer
      );
      return jsonb_build_object(
        'ok', false,
        'code', 'SEND_COOLDOWN',
        'retry_after_seconds', v_retry_after
      );
    end if;

    if v_row.burst_window_started_at <= v_now - interval '15 minutes' then
      v_burst_started := v_now;
      v_burst_count := 1;
    else
      v_burst_started := v_row.burst_window_started_at;
      v_burst_count := v_row.burst_request_count + 1;
    end if;

    if v_burst_count > 3 then
      return jsonb_build_object(
        'ok', false,
        'code', 'BURST_LIMIT_REACHED',
        'retry_after_seconds', greatest(
          1,
          ceiling(extract(epoch from (
            v_burst_started + interval '15 minutes' - v_now
          )))::integer
        )
      );
    end if;

    if v_row.daily_window_started_at <= v_now - interval '24 hours' then
      v_daily_started := v_now;
      v_daily_count := 1;
    else
      v_daily_started := v_row.daily_window_started_at;
      v_daily_count := v_row.daily_request_count + 1;
    end if;

    if v_daily_count > 10 then
      return jsonb_build_object(
        'ok', false,
        'code', 'DAILY_LIMIT_REACHED',
        'retry_after_seconds', greatest(
          1,
          ceiling(extract(epoch from (
            v_daily_started + interval '24 hours' - v_now
          )))::integer
        )
      );
    end if;

    update public.aegis_chat_pin_reset_challenges
    set challenge_id = v_challenge_id,
        code_hash = p_code_hash,
        code_salt = p_code_salt,
        code_expires_at = p_expires_at,
        failed_attempts = 0,
        locked_until = null,
        requested_at = v_now,
        last_sent_at = v_now,
        burst_window_started_at = v_burst_started,
        burst_request_count = v_burst_count,
        daily_window_started_at = v_daily_started,
        daily_request_count = v_daily_count,
        authorization_hash = null,
        authorization_expires_at = null,
        authorized_device_id = null,
        authorized_at = null,
        consumed_at = null,
        updated_at = v_now
    where user_id = p_user_id;
  else
    insert into public.aegis_chat_pin_reset_challenges (
      user_id,
      challenge_id,
      code_hash,
      code_salt,
      code_expires_at,
      last_sent_at,
      requested_at,
      burst_window_started_at,
      burst_request_count,
      daily_window_started_at,
      daily_request_count,
      updated_at
    ) values (
      p_user_id,
      v_challenge_id,
      p_code_hash,
      p_code_salt,
      p_expires_at,
      v_now,
      v_now,
      v_now,
      1,
      v_now,
      1,
      v_now
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'challenge_id', v_challenge_id,
    'expires_at', p_expires_at
  );
end;
$function$;

create or replace function public.aegis_chat_pin_reset_authorize(
  p_user_id uuid,
  p_challenge_id uuid,
  p_expected_code_hash text,
  p_authorization_hash text,
  p_authorization_expires_at timestamptz,
  p_device_id text,
  p_device_proof_issued_at_ms bigint,
  p_device_proof_signature text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_now_ms bigint;
  v_row public.aegis_chat_pin_reset_challenges%rowtype;
  v_generation bigint;
  v_attempts integer;
  v_locked_until timestamptz;
  v_proof_payload text;
begin
  v_now_ms := floor(extract(epoch from v_now) * 1000)::bigint;

  if p_expected_code_hash is null
     or p_expected_code_hash !~ '^[A-Za-z0-9+/]+={0,2}$'
     or length(p_expected_code_hash) not between 40 and 128
     or p_authorization_hash is null
     or p_authorization_hash !~ '^[A-Za-z0-9+/]+={0,2}$'
     or length(p_authorization_hash) not between 40 and 128
     or p_authorization_expires_at <= v_now
     or p_authorization_expires_at > v_now + interval '5 minutes'
     or p_device_id is null
     or p_device_id !~ '^dev_[a-f0-9]{32}$'
     or p_device_proof_issued_at_ms is null
     or p_device_proof_issued_at_ms < v_now_ms - 120000
     or p_device_proof_issued_at_ms > v_now_ms + 30000
     or p_device_proof_signature is null
     or p_device_proof_signature !~ '^[A-Za-z0-9+/]+={0,2}$'
     or length(p_device_proof_signature) not between 80 and 256 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_AUTHORIZATION');
  end if;

  select challenge.*
  into v_row
  from public.aegis_chat_pin_reset_challenges challenge
  where challenge.user_id = p_user_id
    and challenge.challenge_id = p_challenge_id
  for update;

  if not found
     or v_row.consumed_at is not null
     or v_row.code_hash is null
     or v_row.code_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'CHALLENGE_NOT_ACTIVE');
  end if;
  if v_row.locked_until is not null and v_row.locked_until > v_now then
    return jsonb_build_object('ok', false, 'code', 'RATE_LIMITED');
  end if;
  if v_row.code_hash is distinct from p_expected_code_hash then
    v_attempts := least(v_row.failed_attempts + 1, 5);
    v_locked_until := case
      when v_attempts >= 5 then v_now + interval '5 minutes'
      else null
    end;

    update public.aegis_chat_pin_reset_challenges
    set failed_attempts = v_attempts,
        locked_until = v_locked_until,
        code_hash = case when v_attempts >= 5 then null else code_hash end,
        code_salt = case when v_attempts >= 5 then null else code_salt end,
        code_expires_at = case when v_attempts >= 5 then null else code_expires_at end,
        updated_at = v_now
    where user_id = p_user_id;

    return jsonb_build_object(
      'ok', false,
      'code', 'CODE_MISMATCH',
      'attempts_remaining', greatest(0, 5 - v_attempts),
      'locked_until', v_locked_until
    );
  end if;

  v_proof_payload := 'forsure-aegis-pin-reset|'
    || p_challenge_id::text || '|'
    || p_user_id::text || '|'
    || p_device_id || '|'
    || p_device_proof_issued_at_ms::text;

  if not exists (
    select 1
    from public.user_devices device
    join lateral (
      select account.*
      from public.user_public_keys account
      where account.user_id = device.user_id
        and account.is_active is true
      order by account.created_at desc
      limit 1
    ) account on true
    where device.user_id = p_user_id
      and device.device_id = p_device_id
      and device.is_active is true
      and device.revoked_at is null
      and device.stale_at is null
      and device.crypto_invalid_at is null
      and device.approval_status = 'approved'
      and device.binding_status = 'bound'
      and device.account_bound_at is not null
      and device.routing_status = 'ready'
      and device.lifecycle_status = 'ready'
      and device.libsignal_device_number between 1 and 127
      and nullif(trim(device.device_public_key), '') is not null
      and nullif(trim(device.device_signing_key), '') is not null
      and nullif(trim(device.device_authorization_signature), '') is not null
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
      and public.aegis_verify_ed25519(
        device.device_signing_key,
        p_device_proof_signature,
        convert_to(v_proof_payload, 'UTF8')
      )
      and exists (
        select 1
        from public.device_libsignal_prekey_bundles bundle
        where bundle.user_id = device.user_id
          and bundle.device_id = device.device_id
          and bundle.device_number = device.libsignal_device_number
          and length(bundle.public_bundle) between 100 and 262144
      )
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_PROOF_INVALID');
  end if;

  select vault.generation
  into v_generation
  from public.aegis_pin_continuity_vault vault
  where vault.user_id = p_user_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'PIN_CONTINUITY_NOT_FOUND');
  end if;

  update public.aegis_chat_pin_reset_challenges
  set authorization_hash = p_authorization_hash,
      authorization_expires_at = p_authorization_expires_at,
      authorized_device_id = p_device_id,
      authorized_at = v_now,
      code_hash = null,
      code_salt = null,
      code_expires_at = null,
      failed_attempts = 0,
      locked_until = null,
      updated_at = v_now
  where user_id = p_user_id;

  return jsonb_build_object(
    'ok', true,
    'generation', v_generation,
    'authorization_expires_at', p_authorization_expires_at
  );
end;
$function$;

create or replace function public.aegis_chat_pin_reset_commit(
  p_user_id uuid,
  p_challenge_id uuid,
  p_authorization_hash text,
  p_device_id text,
  p_expected_generation bigint,
  p_version integer,
  p_ciphertext text,
  p_iv text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.aegis_chat_pin_reset_challenges%rowtype;
  v_current_generation bigint;
  v_next_generation bigint;
  v_ciphertext_bytes integer;
  v_iv_bytes integer;
begin
  if p_version is distinct from 1
     or p_expected_generation is null
     or p_expected_generation < 1
     or p_authorization_hash is null
     or p_authorization_hash !~ '^[A-Za-z0-9+/]+={0,2}$'
     or length(p_authorization_hash) not between 40 and 128
     or p_device_id is null
     or p_device_id !~ '^dev_[a-f0-9]{32}$'
     or p_ciphertext is null
     or p_ciphertext !~ '^[A-Za-z0-9+/]+={0,2}$'
     or p_iv is null
     or p_iv !~ '^[A-Za-z0-9+/]+={0,2}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ENVELOPE');
  end if;

  begin
    v_ciphertext_bytes := octet_length(decode(p_ciphertext, 'base64'));
    v_iv_bytes := octet_length(decode(p_iv, 'base64'));
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ENVELOPE');
  end;

  if v_iv_bytes <> 12
     or v_ciphertext_bytes < 48
     or v_ciphertext_bytes > 6144 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ENVELOPE');
  end if;

  select challenge.*
  into v_row
  from public.aegis_chat_pin_reset_challenges challenge
  where challenge.user_id = p_user_id
    and challenge.challenge_id = p_challenge_id
  for update;

  if not found
     or v_row.consumed_at is not null
     or v_row.authorization_hash is null
     or v_row.authorization_expires_at <= v_now
     or v_row.authorization_hash is distinct from p_authorization_hash
     or v_row.authorized_device_id is distinct from p_device_id then
    return jsonb_build_object('ok', false, 'code', 'RESET_NOT_AUTHORIZED');
  end if;

  if not exists (
    select 1
    from public.user_devices device
    join lateral (
      select account.*
      from public.user_public_keys account
      where account.user_id = device.user_id
        and account.is_active is true
      order by account.created_at desc
      limit 1
    ) account on true
    where device.user_id = p_user_id
      and device.device_id = p_device_id
      and device.is_active is true
      and device.revoked_at is null
      and device.stale_at is null
      and device.crypto_invalid_at is null
      and device.approval_status = 'approved'
      and device.binding_status = 'bound'
      and device.account_bound_at is not null
      and device.routing_status = 'ready'
      and device.lifecycle_status = 'ready'
      and device.libsignal_device_number between 1 and 127
      and nullif(trim(device.device_public_key), '') is not null
      and nullif(trim(device.device_signing_key), '') is not null
      and nullif(trim(device.device_authorization_signature), '') is not null
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
      and exists (
        select 1
        from public.device_libsignal_prekey_bundles bundle
        where bundle.user_id = device.user_id
          and bundle.device_id = device.device_id
          and bundle.device_number = device.libsignal_device_number
          and length(bundle.public_bundle) between 100 and 262144
      )
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_READY');
  end if;

  select vault.generation
  into v_current_generation
  from public.aegis_pin_continuity_vault vault
  where vault.user_id = p_user_id
  for update;

  if not found or v_current_generation is distinct from p_expected_generation then
    return jsonb_build_object('ok', false, 'code', 'PIN_GENERATION_CHANGED');
  end if;

  v_next_generation := v_current_generation + 1;

  update public.aegis_pin_continuity_vault
  set version = p_version,
      ciphertext = p_ciphertext,
      iv = p_iv,
      generation = v_next_generation,
      updated_at = v_now
  where user_id = p_user_id;

  insert into public.user_chat_pins (
    user_id,
    pin_hash,
    salt,
    failed_attempts,
    locked_until,
    reset_code_hash,
    reset_code_salt,
    reset_code_expires,
    updated_at
  ) values (
    p_user_id,
    gen_random_uuid()::text || gen_random_uuid()::text,
    gen_random_uuid()::text || gen_random_uuid()::text,
    0,
    null,
    null,
    null,
    null,
    v_now
  )
  on conflict (user_id) do update
  set pin_hash = excluded.pin_hash,
      salt = excluded.salt,
      failed_attempts = 0,
      locked_until = null,
      reset_code_hash = null,
      reset_code_salt = null,
      reset_code_expires = null,
      updated_at = v_now;

  update public.aegis_chat_pin_reset_challenges
  set consumed_at = v_now,
      authorization_hash = null,
      authorization_expires_at = null,
      updated_at = v_now
  where user_id = p_user_id;

  return jsonb_build_object(
    'ok', true,
    'generation', v_next_generation
  );
end;
$function$;

create or replace function public.aegis_pin_continuity_state()
returns table (
  version integer,
  ciphertext text,
  iv text,
  generation bigint,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'AEGIS_PIN_CONTINUITY_UNAUTHENTICATED'
      using errcode = '42501';
  end if;

  return query
  select
    vault.version,
    vault.ciphertext,
    vault.iv,
    vault.generation,
    vault.updated_at
  from public.aegis_pin_continuity_vault vault
  where vault.user_id = v_uid;
end;
$function$;

revoke all on function public.aegis_chat_pin_reset_begin(uuid, text, text, timestamptz)
from public, anon, authenticated;
revoke all on function public.aegis_chat_pin_reset_authorize(uuid, uuid, text, text, timestamptz, text, bigint, text)
from public, anon, authenticated;
revoke all on function public.aegis_chat_pin_reset_commit(uuid, uuid, text, text, bigint, integer, text, text)
from public, anon, authenticated;
revoke all on function public.aegis_pin_continuity_state()
from public, anon, authenticated;
revoke all on function public.aegis_pin_continuity_upsert(integer, text, text)
from public, anon, authenticated;

grant execute on function public.aegis_chat_pin_reset_begin(uuid, text, text, timestamptz)
to service_role;
grant execute on function public.aegis_chat_pin_reset_authorize(uuid, uuid, text, text, timestamptz, text, bigint, text)
to service_role;
grant execute on function public.aegis_chat_pin_reset_commit(uuid, uuid, text, text, bigint, integer, text, text)
to service_role;
grant execute on function public.aegis_pin_continuity_state()
to authenticated, service_role;
grant execute on function public.aegis_pin_continuity_upsert(integer, text, text)
to authenticated, service_role;

do $verification$
begin
  if has_table_privilege('authenticated', 'public.user_chat_pins', 'select')
     or has_table_privilege('authenticated', 'public.user_chat_pins', 'insert')
     or has_table_privilege('authenticated', 'public.user_chat_pins', 'update')
     or has_table_privilege('authenticated', 'public.user_chat_pins', 'delete') then
    raise exception 'CHAT_PIN_DIRECT_AUTHENTICATED_ACCESS';
  end if;

  if has_table_privilege('authenticated', 'public.aegis_chat_pin_reset_challenges', 'select')
     or has_table_privilege('anon', 'public.aegis_chat_pin_reset_challenges', 'select') then
    raise exception 'CHAT_PIN_RESET_CHALLENGE_EXPOSED';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.aegis_chat_pin_reset_commit(uuid,uuid,text,text,bigint,integer,text,text)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.aegis_chat_pin_reset_commit(uuid,uuid,text,text,bigint,integer,text,text)',
    'execute'
  ) then
    raise exception 'CHAT_PIN_RESET_COMMIT_EXPOSED';
  end if;

  if has_function_privilege(
    'authenticated',
    'public.aegis_chat_pin_reset_authorize(uuid,uuid,text,text,timestamptz,text,bigint,text)',
    'execute'
  ) or has_function_privilege(
    'anon',
    'public.aegis_chat_pin_reset_authorize(uuid,uuid,text,text,timestamptz,text,bigint,text)',
    'execute'
  ) then
    raise exception 'CHAT_PIN_RESET_AUTHORIZE_EXPOSED';
  end if;

  if not has_function_privilege(
    'service_role',
    'public.aegis_chat_pin_reset_commit(uuid,uuid,text,text,bigint,integer,text,text)',
    'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.aegis_pin_continuity_state()',
    'execute'
  ) then
    raise exception 'CHAT_PIN_RESET_REQUIRED_GRANTS_MISSING';
  end if;
end;
$verification$;

notify pgrst, 'reload schema';

commit;
