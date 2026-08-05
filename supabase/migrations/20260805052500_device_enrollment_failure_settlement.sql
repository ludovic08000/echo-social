-- Make two-phase device enrollment recoverable after ambiguous network failures.
-- A lost HTTP response must not cause the client to delete keys for a device
-- that the server already committed. Cancellation is nonce-bound, terminal and
-- idempotent; successful completion can also be recovered idempotently.

alter table public.device_enrollment_challenges
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text;

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
  v_device_exists boolean;
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

  select exists (
    select 1
    from public.user_devices device
    where device.user_id = v_uid
      and device.device_id = v_challenge.device_id
      and device.revoked_at is null
  ) into v_device_exists;

  if v_challenge.cancelled_at is not null then
    return jsonb_build_object(
      'ok', false,
      'code', 'DEVICE_ENROLLMENT_CANCELLED',
      'device_id', v_challenge.device_id
    );
  end if;

  if v_challenge.consumed_at is not null then
    if v_device_exists then
      return jsonb_build_object(
        'ok', true,
        'code', 'DEVICE_ENROLLMENT_ALREADY_COMPLETED',
        'challenge_id', v_challenge.id,
        'device_id', v_challenge.device_id,
        'routing_status', 'repairing'
      );
    end if;
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_REPLAYED');
  end if;

  if v_challenge.expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_EXPIRED');
  end if;

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

create or replace function public.cancel_user_device_enrollment(
  p_challenge_id uuid,
  p_nonce text,
  p_reason text default 'client_failure'
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
  v_device_exists boolean;
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

  select exists (
    select 1
    from public.user_devices device
    where device.user_id = v_uid
      and device.device_id = v_challenge.device_id
      and device.revoked_at is null
  ) into v_device_exists;

  if v_device_exists then
    update public.device_enrollment_challenges
    set consumed_at = coalesce(consumed_at, v_now)
    where id = v_challenge.id;

    return jsonb_build_object(
      'ok', true,
      'code', 'DEVICE_ENROLLMENT_ALREADY_COMPLETED',
      'challenge_id', v_challenge.id,
      'device_id', v_challenge.device_id
    );
  end if;

  if v_challenge.cancelled_at is not null then
    return jsonb_build_object(
      'ok', true,
      'code', 'DEVICE_ENROLLMENT_ALREADY_CANCELLED',
      'challenge_id', v_challenge.id,
      'device_id', v_challenge.device_id
    );
  end if;

  if v_challenge.consumed_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_REPLAYED');
  end if;

  update public.device_enrollment_challenges
  set consumed_at = v_now,
      cancelled_at = v_now,
      cancel_reason = left(coalesce(nullif(trim(p_reason), ''), 'client_failure'), 120)
  where id = v_challenge.id;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_ENROLLMENT_CANCELLED',
    'challenge_id', v_challenge.id,
    'device_id', v_challenge.device_id
  );
end;
$function$;

revoke all on function public.cancel_user_device_enrollment(uuid, text, text)
  from public, anon;
grant execute on function public.cancel_user_device_enrollment(uuid, text, text)
  to authenticated;

comment on function public.cancel_user_device_enrollment(uuid, text, text) is
  'Nonce-bound terminal settlement for an incomplete server-assigned DeviceID challenge.';
