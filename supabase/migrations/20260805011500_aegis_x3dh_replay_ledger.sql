-- Authoritative anti-replay ledger for Aegis X3DH initial messages.
-- Direct table access is denied; authenticated clients can only reserve,
-- finalize or cancel their own responder-side fingerprints through RPCs.

create table if not exists public.aegis_x3dh_initial_replay (
  user_id uuid not null references auth.users(id) on delete cascade,
  fingerprint text not null,
  status text not null check (status in ('reserved', 'finalized')),
  reservation_token uuid,
  reserved_until timestamptz,
  finalized_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, fingerprint),
  constraint aegis_x3dh_replay_fingerprint_format
    check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint aegis_x3dh_replay_state_shape check (
    (
      status = 'reserved'
      and reservation_token is not null
      and reserved_until is not null
      and finalized_at is null
    )
    or
    (
      status = 'finalized'
      and reservation_token is null
      and reserved_until is null
      and finalized_at is not null
    )
  )
);

create index if not exists aegis_x3dh_initial_replay_expiry_idx
  on public.aegis_x3dh_initial_replay (expires_at);

alter table public.aegis_x3dh_initial_replay enable row level security;

revoke all on public.aegis_x3dh_initial_replay from public, anon, authenticated;

create or replace function public.reserve_x3dh_initial(
  p_fingerprint text,
  p_ttl_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_ttl_seconds integer := greatest(30, least(coalesce(p_ttl_seconds, 120), 300));
  v_token uuid := gen_random_uuid();
  v_existing public.aegis_x3dh_initial_replay%rowtype;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_X3DH_FINGERPRINT' using errcode = '22023';
  end if;

  -- Serialize reservations for one authenticated responder and one tuple.
  perform pg_advisory_xact_lock(
    hashtextextended(v_uid::text || ':' || p_fingerprint, 0)
  );

  select * into v_existing
  from public.aegis_x3dh_initial_replay
  where user_id = v_uid
    and fingerprint = p_fingerprint
  for update;

  if found then
    if v_existing.status = 'finalized' and v_existing.expires_at > v_now then
      return jsonb_build_object('ok', false, 'state', 'replay');
    end if;
    if v_existing.status = 'reserved'
       and v_existing.reserved_until is not null
       and v_existing.reserved_until > v_now then
      return jsonb_build_object('ok', false, 'state', 'busy');
    end if;

    update public.aegis_x3dh_initial_replay
    set status = 'reserved',
        reservation_token = v_token,
        reserved_until = v_now + make_interval(secs => v_ttl_seconds),
        finalized_at = null,
        expires_at = v_now + make_interval(secs => v_ttl_seconds),
        updated_at = v_now
    where user_id = v_uid
      and fingerprint = p_fingerprint;
  else
    insert into public.aegis_x3dh_initial_replay (
      user_id,
      fingerprint,
      status,
      reservation_token,
      reserved_until,
      finalized_at,
      expires_at,
      created_at,
      updated_at
    ) values (
      v_uid,
      p_fingerprint,
      'reserved',
      v_token,
      v_now + make_interval(secs => v_ttl_seconds),
      null,
      v_now + make_interval(secs => v_ttl_seconds),
      v_now,
      v_now
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'state', 'reserved',
    'reservation_token', v_token::text
  );
end;
$function$;

create or replace function public.finalize_x3dh_initial(
  p_fingerprint text,
  p_reservation_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
     or p_reservation_token is null then
    return false;
  end if;

  update public.aegis_x3dh_initial_replay
  set status = 'finalized',
      reservation_token = null,
      reserved_until = null,
      finalized_at = v_now,
      expires_at = v_now + interval '7 days',
      updated_at = v_now
  where user_id = v_uid
    and fingerprint = p_fingerprint
    and status = 'reserved'
    and reservation_token = p_reservation_token
    and reserved_until > v_now;

  return found;
end;
$function$;

create or replace function public.cancel_x3dh_initial(
  p_fingerprint text,
  p_reservation_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
     or p_reservation_token is null then
    return false;
  end if;

  delete from public.aegis_x3dh_initial_replay
  where user_id = v_uid
    and fingerprint = p_fingerprint
    and status = 'reserved'
    and reservation_token = p_reservation_token;

  return found;
end;
$function$;

revoke all on function public.reserve_x3dh_initial(text, integer) from public, anon;
revoke all on function public.finalize_x3dh_initial(text, uuid) from public, anon;
revoke all on function public.cancel_x3dh_initial(text, uuid) from public, anon;

grant execute on function public.reserve_x3dh_initial(text, integer) to authenticated;
grant execute on function public.finalize_x3dh_initial(text, uuid) to authenticated;
grant execute on function public.cancel_x3dh_initial(text, uuid) to authenticated;
