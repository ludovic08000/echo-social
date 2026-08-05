-- Signal-style two-phase enrollment for new logical devices.
-- Existing devices continue to use register_user_device_safe for idempotent repair.
-- New clients call begin_user_device_enrollment, bind their device keys to the
-- returned DeviceID, then atomically consume the challenge with
-- complete_user_device_enrollment.

create table if not exists public.device_enrollment_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  nonce_hash text not null,
  device_name text,
  device_fingerprint text,
  platform text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  constraint device_enrollment_device_id_format
    check (device_id ~ '^dev_[a-f0-9]{32}$'),
  constraint device_enrollment_platform_check
    check (platform in ('ios', 'android', 'web')),
  constraint device_enrollment_expiry_check
    check (expires_at > created_at),
  constraint device_enrollment_unique_device
    unique (user_id, device_id)
);

create index if not exists device_enrollment_active_user_idx
  on public.device_enrollment_challenges (user_id, expires_at)
  where consumed_at is null;

alter table public.device_enrollment_challenges enable row level security;
revoke all on table public.device_enrollment_challenges from public, anon, authenticated;

create or replace function public.begin_user_device_enrollment(
  p_device_name text default null,
  p_device_fingerprint text default null,
  p_platform text default 'web',
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_platform text := lower(trim(coalesce(p_platform, 'web')));
  v_device_id text;
  v_nonce text;
  v_challenge_id uuid;
  v_expires_at timestamptz := v_now + interval '10 minutes';
  v_active_count integer;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  if v_platform not in ('ios', 'android', 'web') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PLATFORM');
  end if;

  -- Keep the private ledger bounded without exposing it through RLS.
  delete from public.device_enrollment_challenges
  where user_id = v_uid
    and (
      expires_at < v_now - interval '1 day'
      or consumed_at < v_now - interval '1 day'
    );

  select count(*) into v_active_count
  from public.device_enrollment_challenges
  where user_id = v_uid
    and consumed_at is null
    and expires_at > v_now;

  if v_active_count >= 5 then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_RATE_LIMITED');
  end if;

  v_device_id := 'dev_' || replace(gen_random_uuid()::text, '-', '');
  v_nonce := encode(extensions.gen_random_bytes(32), 'base64');

  insert into public.device_enrollment_challenges (
    user_id,
    device_id,
    nonce_hash,
    device_name,
    device_fingerprint,
    platform,
    user_agent,
    created_at,
    expires_at
  ) values (
    v_uid,
    v_device_id,
    encode(extensions.digest(convert_to(v_nonce, 'UTF8'), 'sha256'), 'hex'),
    nullif(left(trim(coalesce(p_device_name, '')), 120), ''),
    nullif(left(trim(coalesce(p_device_fingerprint, '')), 256), ''),
    v_platform,
    nullif(left(coalesce(p_user_agent, ''), 500), ''),
    v_now,
    v_expires_at
  )
  returning id into v_challenge_id;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_ENROLLMENT_CHALLENGE_CREATED',
    'challenge_id', v_challenge_id,
    'device_id', v_device_id,
    'nonce', v_nonce,
    'expires_at', v_expires_at
  );
end;
$function$;

create or replace function public.complete_user_device_enrollment(
  p_challenge_id uuid,
  p_nonce text,
  p_device_public_key text,
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
as $function$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_challenge public.device_enrollment_challenges%rowtype;
  v_nonce_hash text;
  v_result jsonb;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  select * into v_challenge
  from public.device_enrollment_challenges
  where id = p_challenge_id
    and user_id = v_uid
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_CHALLENGE_NOT_FOUND');
  end if;

  if v_challenge.consumed_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_REPLAYED');
  end if;

  if v_challenge.expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_EXPIRED');
  end if;

  if length(coalesce(p_nonce, '')) < 32 then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_INVALID_NONCE');
  end if;

  v_nonce_hash := encode(
    extensions.digest(convert_to(p_nonce, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_nonce_hash is distinct from v_challenge.nonce_hash then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_INVALID_NONCE');
  end if;

  -- The existing function pins the account root, checks key continuity and
  -- inserts the device in one transaction. Crucially, its DeviceID now comes
  -- from the locked server challenge rather than from the client.
  v_result := public.register_user_device_safe(
    v_uid,
    v_challenge.device_id,
    v_challenge.device_name,
    p_device_public_key,
    v_challenge.device_fingerprint,
    v_challenge.platform,
    v_challenge.user_agent,
    p_device_signing_key,
    p_device_authorization_signature,
    p_account_identity_key,
    p_account_signing_key,
    p_account_fingerprint,
    p_account_binding_signature
  );

  if coalesce((v_result ->> 'ok')::boolean, false) is not true then
    return v_result || jsonb_build_object(
      'challenge_id', v_challenge.id,
      'device_id', v_challenge.device_id
    );
  end if;

  update public.device_enrollment_challenges
  set consumed_at = v_now
  where id = v_challenge.id;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_ENROLLMENT_COMPLETED',
    'challenge_id', v_challenge.id,
    'device_id', v_challenge.device_id,
    'routing_status', 'repairing'
  );
end;
$function$;

revoke all on function public.begin_user_device_enrollment(text, text, text, text)
  from public, anon;
revoke all on function public.complete_user_device_enrollment(uuid, text, text, text, text, text, text, text, text)
  from public, anon;
grant execute on function public.begin_user_device_enrollment(text, text, text, text)
  to authenticated;
grant execute on function public.complete_user_device_enrollment(uuid, text, text, text, text, text, text, text, text)
  to authenticated;

comment on table public.device_enrollment_challenges is
  'Private short-lived ledger for server-assigned Aegis DeviceIDs.';
comment on function public.begin_user_device_enrollment(text, text, text, text) is
  'Allocates an opaque DeviceID and one-time challenge for the authenticated user.';
comment on function public.complete_user_device_enrollment(uuid, text, text, text, text, text, text, text, text) is
  'Atomically consumes an enrollment challenge and registers keys under the server-assigned DeviceID.';
