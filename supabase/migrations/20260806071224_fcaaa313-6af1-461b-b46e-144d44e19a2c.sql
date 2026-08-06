-- Invariant corrigé : un même appareil web (empreinte + plateforme) ne doit jamais
-- créer plusieurs routes lors d'une reprise après timeout réseau ; on réutilise le
-- DeviceID serveur déjà attribué en faisant tourner le nonce (jamais rejouable).

create or replace function public.begin_user_device_enrollment(
  p_device_name text default null,
  p_device_fingerprint text default null,
  p_platform text default 'web',
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_platform text := lower(trim(coalesce(p_platform, 'web')));
  v_fingerprint text := nullif(left(trim(coalesce(p_device_fingerprint, '')), 256), '');
  v_device_name text := nullif(left(trim(coalesce(p_device_name, '')), 120), '');
  v_user_agent text := nullif(left(coalesce(p_user_agent, ''), 500), '');
  v_device_id text;
  v_nonce text;
  v_nonce_hash text;
  v_challenge_id uuid;
  v_expires_at timestamptz := v_now + interval '10 minutes';
  v_active_count integer;
  v_reuse public.device_enrollment_challenges%rowtype;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if v_platform not in ('ios', 'android', 'web') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PLATFORM');
  end if;

  -- Purge élargie : les challenges expirés ou clos ne doivent plus consommer le quota.
  delete from public.device_enrollment_challenges
  where user_id = v_uid
    and (
      expires_at < v_now - interval '1 hour'
      or consumed_at < v_now - interval '1 hour'
      or cancelled_at < v_now - interval '1 hour'
    );

  v_nonce := encode(extensions.gen_random_bytes(32), 'base64');
  v_nonce_hash := encode(extensions.digest(convert_to(v_nonce, 'UTF8'), 'sha256'), 'hex');

  -- Reprise idempotente : même appareil, enrôlement encore ouvert -> même DeviceID,
  -- nonce régénéré (l'ancien devient inutilisable) et expiration relancée.
  if v_fingerprint is not null then
    select * into v_reuse
    from public.device_enrollment_challenges
    where user_id = v_uid
      and device_fingerprint = v_fingerprint
      and platform = v_platform
      and consumed_at is null
      and cancelled_at is null
    order by created_at desc
    limit 1
    for update;

    if found and not exists (
      select 1 from public.user_devices d
      where d.user_id = v_uid and d.device_id = v_reuse.device_id
    ) then
      update public.device_enrollment_challenges
      set nonce_hash = v_nonce_hash,
          expires_at = v_expires_at,
          device_name = coalesce(v_device_name, device_name),
          user_agent = coalesce(v_user_agent, user_agent)
      where id = v_reuse.id;

      return jsonb_build_object(
        'ok', true,
        'code', 'DEVICE_ENROLLMENT_CHALLENGE_CREATED',
        'challenge_id', v_reuse.id,
        'device_id', v_reuse.device_id,
        'nonce', v_nonce,
        'expires_at', v_expires_at,
        'resumed', true
      );
    end if;
  end if;

  select count(*) into v_active_count
  from public.device_enrollment_challenges
  where user_id = v_uid and consumed_at is null and cancelled_at is null and expires_at > v_now;

  if v_active_count >= 5 then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_RATE_LIMITED');
  end if;

  v_device_id := 'dev_' || replace(gen_random_uuid()::text, '-', '');

  insert into public.device_enrollment_challenges (
    user_id, device_id, nonce_hash, device_name, device_fingerprint,
    platform, user_agent, created_at, expires_at
  ) values (
    v_uid, v_device_id, v_nonce_hash, v_device_name, v_fingerprint,
    v_platform, v_user_agent, v_now, v_expires_at
  ) returning id into v_challenge_id;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_ENROLLMENT_CHALLENGE_CREATED',
    'challenge_id', v_challenge_id,
    'device_id', v_device_id,
    'nonce', v_nonce,
    'expires_at', v_expires_at,
    'resumed', false
  );
end;
$fn$;

-- Invariant corrigé : après une inscription réussie, aucun challenge frère du même
-- appareil ne doit rester ouvert et produire une seconde route orpheline.
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
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := now();
  v_challenge public.device_enrollment_challenges%rowtype;
  v_nonce_hash text;
  v_result jsonb;
  v_device_exists boolean;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED'); end if;

  select * into v_challenge
  from public.device_enrollment_challenges
  where id = p_challenge_id and user_id = v_uid
  for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_CHALLENGE_NOT_FOUND'); end if;

  if length(coalesce(p_nonce, '')) < 32 then return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_INVALID_NONCE'); end if;
  v_nonce_hash := encode(extensions.digest(convert_to(p_nonce, 'UTF8'), 'sha256'), 'hex');
  if v_nonce_hash is distinct from v_challenge.nonce_hash then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_INVALID_NONCE');
  end if;

  select exists (
    select 1 from public.user_devices device
    where device.user_id = v_uid and device.device_id = v_challenge.device_id and device.revoked_at is null
  ) into v_device_exists;

  if v_challenge.cancelled_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_CANCELLED', 'device_id', v_challenge.device_id);
  end if;

  if v_challenge.consumed_at is not null then
    if v_device_exists then
      return jsonb_build_object('ok', true, 'code', 'DEVICE_ENROLLMENT_ALREADY_COMPLETED', 'challenge_id', v_challenge.id, 'device_id', v_challenge.device_id, 'routing_status', 'repairing');
    end if;
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_REPLAYED');
  end if;

  if v_challenge.expires_at <= v_now then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_EXPIRED');
  end if;

  v_result := public.register_user_device_safe(
    v_uid, v_challenge.device_id, v_challenge.device_name, p_device_public_key,
    v_challenge.device_fingerprint, v_challenge.platform, v_challenge.user_agent,
    p_device_signing_key, p_device_authorization_signature,
    p_account_identity_key, p_account_signing_key, p_account_fingerprint, p_account_binding_signature
  );

  if coalesce((v_result ->> 'ok')::boolean, false) is not true then
    return v_result || jsonb_build_object('challenge_id', v_challenge.id, 'device_id', v_challenge.device_id);
  end if;

  update public.device_enrollment_challenges set consumed_at = v_now where id = v_challenge.id;

  if v_challenge.device_fingerprint is not null then
    update public.device_enrollment_challenges
    set consumed_at = v_now,
        cancelled_at = v_now,
        cancel_reason = 'superseded_by_completed_enrollment'
    where user_id = v_uid
      and id <> v_challenge.id
      and device_fingerprint = v_challenge.device_fingerprint
      and platform = v_challenge.platform
      and consumed_at is null
      and cancelled_at is null;
  end if;

  return jsonb_build_object('ok', true, 'code', 'DEVICE_ENROLLMENT_COMPLETED', 'challenge_id', v_challenge.id, 'device_id', v_challenge.device_id, 'routing_status', 'repairing');
end;
$fn$;

-- Reprise en lecture seule : permet à un navigateur iOS ayant perdu son état local
-- de retrouver son DeviceID serveur déjà enregistré, sans approbation implicite.
create or replace function public.resume_user_device_enrollment(
  p_device_fingerprint text,
  p_platform text default 'web'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_uid uuid := auth.uid();
  v_platform text := lower(trim(coalesce(p_platform, 'web')));
  v_fingerprint text := nullif(left(trim(coalesce(p_device_fingerprint, '')), 256), '');
  v_device public.user_devices%rowtype;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED'); end if;
  if v_platform not in ('ios', 'android', 'web') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PLATFORM');
  end if;
  if v_fingerprint is null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_FINGERPRINT_REQUIRED');
  end if;

  select * into v_device
  from public.user_devices d
  where d.user_id = v_uid
    and d.device_fingerprint = v_fingerprint
    and lower(coalesce(d.platform, 'web')) = v_platform
    and d.is_active = true
    and d.revoked_at is null
    and d.crypto_invalid_at is null
    and lower(coalesce(d.approval_status, 'approved')) = 'approved'
  order by d.last_seen_at desc nulls last, d.created_at desc
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_ENROLLMENT_NO_RESUMABLE_DEVICE');
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', 'DEVICE_ENROLLMENT_RESUMABLE',
    'device_id', v_device.device_id,
    'platform', v_device.platform,
    'routing_status', v_device.routing_status
  );
end;
$fn$;

revoke all on function public.begin_user_device_enrollment(text, text, text, text) from public, anon;
revoke all on function public.complete_user_device_enrollment(uuid, text, text, text, text, text, text, text, text) from public, anon;
revoke all on function public.resume_user_device_enrollment(text, text) from public, anon;
grant execute on function public.begin_user_device_enrollment(text, text, text, text) to authenticated;
grant execute on function public.complete_user_device_enrollment(uuid, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.resume_user_device_enrollment(text, text) to authenticated;

notify pgrst, 'reload schema';