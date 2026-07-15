begin;

create table if not exists public.x3dh_initial_reservations (
  user_id uuid not null references auth.users(id) on delete cascade,
  fingerprint text not null,
  reservation_token uuid not null,
  status text not null check (status in ('reserved', 'finalized')),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finalized_at timestamptz,
  primary key (user_id, fingerprint)
);

create index if not exists x3dh_initial_reservations_expiry_idx
  on public.x3dh_initial_reservations (expires_at)
  where status = 'reserved';

alter table public.x3dh_initial_reservations enable row level security;
revoke all on public.x3dh_initial_reservations from anon, authenticated;

create or replace function public.reserve_x3dh_initial(
  p_fingerprint text,
  p_ttl_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.x3dh_initial_reservations%rowtype;
  v_token uuid := gen_random_uuid();
  v_ttl integer := greatest(30, least(coalesce(p_ttl_seconds, 120), 600));
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;
  if p_fingerprint is null or length(p_fingerprint) <> 64 then
    raise exception 'INVALID_X3DH_FINGERPRINT' using errcode = '22023';
  end if;

  delete from public.x3dh_initial_reservations r
  where r.user_id = v_uid
    and r.fingerprint = p_fingerprint
    and r.status = 'reserved'
    and r.expires_at <= now();

  select * into v_row
  from public.x3dh_initial_reservations r
  where r.user_id = v_uid and r.fingerprint = p_fingerprint
  for update;

  if found then
    if v_row.status = 'finalized' then
      return jsonb_build_object('ok', false, 'state', 'replay');
    end if;
    return jsonb_build_object('ok', false, 'state', 'busy');
  end if;

  insert into public.x3dh_initial_reservations (
    user_id, fingerprint, reservation_token, status, reserved_at, expires_at
  ) values (
    v_uid, p_fingerprint, v_token, 'reserved', now(), now() + make_interval(secs => v_ttl)
  );

  return jsonb_build_object(
    'ok', true,
    'state', 'reserved',
    'reservation_token', v_token,
    'expires_in_seconds', v_ttl
  );
end;
$$;

create or replace function public.finalize_x3dh_initial(
  p_fingerprint text,
  p_reservation_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_updated integer;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  update public.x3dh_initial_reservations r
  set status = 'finalized',
      finalized_at = now(),
      expires_at = now() + interval '7 days'
  where r.user_id = v_uid
    and r.fingerprint = p_fingerprint
    and r.reservation_token = p_reservation_token
    and r.status = 'reserved'
    and r.expires_at > now();
  get diagnostics v_updated = row_count;

  return v_updated = 1;
end;
$$;

create or replace function public.cancel_x3dh_initial(
  p_fingerprint text,
  p_reservation_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_deleted integer;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '28000';
  end if;

  delete from public.x3dh_initial_reservations r
  where r.user_id = v_uid
    and r.fingerprint = p_fingerprint
    and r.reservation_token = p_reservation_token
    and r.status = 'reserved';
  get diagnostics v_deleted = row_count;

  return v_deleted = 1;
end;
$$;

revoke all on function public.reserve_x3dh_initial(text, integer) from public;
revoke all on function public.finalize_x3dh_initial(text, uuid) from public;
revoke all on function public.cancel_x3dh_initial(text, uuid) from public;
grant execute on function public.reserve_x3dh_initial(text, integer) to authenticated;
grant execute on function public.finalize_x3dh_initial(text, uuid) to authenticated;
grant execute on function public.cancel_x3dh_initial(text, uuid) to authenticated;

commit;
