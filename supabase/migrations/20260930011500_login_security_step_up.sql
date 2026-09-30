-- Risk-based login approval for Aegis.
--
-- Rollout is deliberately staged: database enforcement is created disabled.
-- The web client and login-security Edge Function can therefore be deployed
-- and smoke-tested before `enforcement_enabled` is switched on. Once enabled,
-- a password session alone cannot publish an account identity or activate a
-- device route; the exact Supabase auth session must also be approved here.

begin;

create table if not exists public.login_security_config (
  id smallint primary key default 1 check (id = 1),
  enforcement_enabled boolean not null default false,
  enforcement_started_at timestamptz,
  approval_ttl interval not null default interval '30 days',
  challenge_ttl interval not null default interval '5 minutes',
  email_token_ttl interval not null default interval '15 minutes',
  updated_at timestamptz not null default now()
);

insert into public.login_security_config (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.login_security_sessions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired')),
  risk_level text not null default 'high'
    check (risk_level in ('low', 'medium', 'high')),
  risk_reasons jsonb not null default '[]'::jsonb,
  known_device boolean not null default false,
  country_code text,
  region text,
  city text,
  ip_hash text,
  user_agent_hash text,
  user_agent_summary text,
  timezone text,
  language text,
  device_proof_verified_at timestamptz,
  email_sent_at timestamptz,
  approved_at timestamptz,
  denied_at timestamptz,
  approved_via text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create index if not exists login_security_sessions_user_status_idx
  on public.login_security_sessions(user_id, status, created_at desc);
create index if not exists login_security_sessions_device_idx
  on public.login_security_sessions(user_id, device_id, created_at desc)
  where device_id is not null;

create table if not exists public.login_security_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  intent text not null check (intent in ('assess', 'approve', 'deny')),
  target_session_id uuid,
  device_id text,
  payload text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '5 minutes'),
  consumed_at timestamptz
);

create index if not exists login_security_challenges_session_idx
  on public.login_security_challenges(user_id, session_id, expires_at desc);

create table if not exists public.login_security_email_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  target_session_id uuid not null,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  consumed_at timestamptz,
  consumed_decision text check (consumed_decision in ('approve', 'deny'))
);

create index if not exists login_security_email_tokens_target_idx
  on public.login_security_email_tokens(user_id, target_session_id, expires_at desc);

create table if not exists public.login_security_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid,
  event_type text not null,
  outcome text not null check (outcome in ('info', 'success', 'failure')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists login_security_events_user_idx
  on public.login_security_events(user_id, created_at desc);

alter table public.login_security_config enable row level security;
alter table public.login_security_sessions enable row level security;
alter table public.login_security_challenges enable row level security;
alter table public.login_security_email_tokens enable row level security;
alter table public.login_security_events enable row level security;

revoke all on table public.login_security_config
  from public, anon, authenticated;
revoke all on table public.login_security_sessions
  from public, anon, authenticated;
revoke all on table public.login_security_challenges
  from public, anon, authenticated;
revoke all on table public.login_security_email_tokens
  from public, anon, authenticated;
revoke all on table public.login_security_events
  from public, anon, authenticated;

grant all on table public.login_security_config to service_role;
grant all on table public.login_security_sessions to service_role;
grant all on table public.login_security_challenges to service_role;
grant all on table public.login_security_email_tokens to service_role;
grant all on table public.login_security_events to service_role;
grant usage, select on sequence public.login_security_events_id_seq to service_role;

create or replace function public.current_login_security_session_id()
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when coalesce(auth.jwt() ->> 'session_id', '') ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then (auth.jwt() ->> 'session_id')::uuid
    else null
  end;
$$;

create or replace function public.is_current_login_session_approved()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_enabled boolean := false;
  v_session_id uuid;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return true;
  end if;
  if auth.uid() is null then
    return false;
  end if;

  select config.enforcement_enabled
    into v_enabled
    from public.login_security_config config
   where config.id = 1;
  if not coalesce(v_enabled, false) then
    return true;
  end if;

  v_session_id := public.current_login_security_session_id();
  if v_session_id is null then
    return false;
  end if;

  return exists (
    select 1
      from public.login_security_sessions security_session
     where security_session.user_id = auth.uid()
       and security_session.session_id = v_session_id
       and security_session.status = 'approved'
       and security_session.expires_at > now()
  );
end;
$$;

create or replace function public.assert_current_login_session_approved()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_current_login_session_approved() then
    raise exception 'LOGIN_SECURITY_APPROVAL_REQUIRED'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.current_login_security_session_id()
  from public, anon;
revoke all on function public.is_current_login_session_approved()
  from public, anon;
revoke all on function public.assert_current_login_session_approved()
  from public, anon;
grant execute on function public.current_login_security_session_id()
  to authenticated, service_role;
grant execute on function public.is_current_login_session_approved()
  to authenticated, service_role;
grant execute on function public.assert_current_login_session_approved()
  to authenticated, service_role;

-- Replaces the first hardening trigger so browser-originated, verified identity
-- RPCs also require an approved login session once enforcement is activated.
create or replace function public.aegis_guard_account_identity_mutation_v2()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    if tg_op = 'DELETE' then return old; end if;
    if tg_op = 'TRUNCATE' then return null; end if;
    return new;
  end if;

  if current_setting('aegis.identity_mutation_authorized', true) = 'on' then
    perform public.assert_current_login_session_approved();
    if tg_op = 'DELETE' then return old; end if;
    if tg_op = 'TRUNCATE' then return null; end if;
    return new;
  end if;

  raise exception 'IDENTITY_MUTATION_REQUIRES_VERIFIED_RPC'
    using errcode = '42501';
end;
$$;

create or replace function public.aegis_guard_device_activation_by_login_session()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_activating boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  v_activating :=
    (new.approval_status = 'approved'
      and (tg_op = 'INSERT' or old.approval_status is distinct from 'approved'))
    or (new.binding_status = 'bound'
      and (tg_op = 'INSERT' or old.binding_status is distinct from 'bound'))
    or (new.routing_status = 'ready'
      and (tg_op = 'INSERT' or old.routing_status is distinct from 'ready'));

  if v_activating then
    perform public.assert_current_login_session_approved();
  end if;
  return new;
end;
$$;

drop trigger if exists aegis_guard_device_activation_by_login_session
  on public.user_devices;
create trigger aegis_guard_device_activation_by_login_session
before insert or update on public.user_devices
for each row execute function public.aegis_guard_device_activation_by_login_session();

revoke all on function public.aegis_guard_device_activation_by_login_session()
  from public, anon, authenticated;

-- Used only by the service-role Edge Function after a signed rejection or a
-- single-use email denial. Deleting the auth session revokes its refresh token;
-- the login-security status gate rejects sensitive work immediately while an
-- already-issued access token naturally reaches its short expiry.
create or replace function public.revoke_login_security_auth_session(
  p_user_id uuid,
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_deleted integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SERVICE_ROLE_REQUIRED' using errcode = '42501';
  end if;
  delete from auth.sessions
   where id = p_session_id
     and user_id = p_user_id;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

revoke all on function public.revoke_login_security_auth_session(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_login_security_auth_session(uuid, uuid)
  to service_role;

notify pgrst, 'reload schema';

commit;
