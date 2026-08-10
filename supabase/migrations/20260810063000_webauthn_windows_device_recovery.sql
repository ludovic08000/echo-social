create table if not exists public.webauthn_device_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text null,
  purpose text not null check (purpose in ('register','recover')),
  challenge text not null unique check (challenge ~ '^[A-Za-z0-9_-]{32,128}$'),
  rp_id text not null,
  origin text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz null
);

create index if not exists webauthn_device_challenges_user_purpose_idx
  on public.webauthn_device_challenges(user_id, purpose, created_at desc);

create table if not exists public.webauthn_device_credentials (
  credential_id text primary key check (credential_id ~ '^[A-Za-z0-9_-]{16,1024}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  rp_id text not null,
  public_key_spki text not null,
  algorithm integer not null check (algorithm = -7),
  sign_count bigint not null default 0 check (sign_count >= 0),
  transports text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz null,
  revoked_at timestamptz null
);

create index if not exists webauthn_device_credentials_user_idx
  on public.webauthn_device_credentials(user_id, rp_id, revoked_at);
create index if not exists webauthn_device_credentials_device_idx
  on public.webauthn_device_credentials(user_id, device_id, rp_id);

create table if not exists public.webauthn_device_vaults (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  version integer not null check (version = 1),
  iv text not null,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id)
);

alter table public.webauthn_device_challenges enable row level security;
alter table public.webauthn_device_credentials enable row level security;
alter table public.webauthn_device_vaults enable row level security;

revoke all on public.webauthn_device_challenges from anon, authenticated;
revoke all on public.webauthn_device_credentials from anon, authenticated;
revoke all on public.webauthn_device_vaults from anon, authenticated;
grant select, insert, update, delete on public.webauthn_device_challenges to service_role;
grant select, insert, update, delete on public.webauthn_device_credentials to service_role;
grant select, insert, update, delete on public.webauthn_device_vaults to service_role;

create or replace function public.webauthn_finalize_device_registration(
  p_user_id uuid,
  p_device_id text,
  p_challenge_id uuid,
  p_credential_id text,
  p_rp_id text,
  p_public_key_spki text,
  p_algorithm integer,
  p_sign_count bigint,
  p_transports text[],
  p_vault_version integer,
  p_vault_iv text,
  p_vault_ciphertext text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $fn$
declare
  v_challenge public.webauthn_device_challenges%rowtype;
  v_device public.user_devices%rowtype;
begin
  select * into v_challenge
  from public.webauthn_device_challenges
  where id = p_challenge_id
  for update;

  if not found then return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CHALLENGE_NOT_FOUND'); end if;
  if v_challenge.user_id <> p_user_id or v_challenge.device_id is distinct from p_device_id
     or v_challenge.purpose <> 'register' or v_challenge.rp_id <> p_rp_id then
    return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CHALLENGE_MISMATCH');
  end if;
  if v_challenge.consumed_at is not null then return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CHALLENGE_USED'); end if;
  if v_challenge.expires_at <= now() then return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CHALLENGE_EXPIRED'); end if;

  select * into v_device
  from public.user_devices d
  where d.user_id = p_user_id and d.device_id = p_device_id
  for update;

  if not found then return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_FOUND'); end if;
  if v_device.approval_status <> 'approved' or v_device.binding_status <> 'bound'
     or v_device.lifecycle_status <> 'ready' or v_device.routing_status <> 'ready'
     or v_device.is_active <> true or v_device.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_READY');
  end if;

  update public.webauthn_device_credentials
    set revoked_at = coalesce(revoked_at, now())
  where user_id = p_user_id and device_id = p_device_id and rp_id = p_rp_id
    and credential_id <> p_credential_id and revoked_at is null;

  insert into public.webauthn_device_credentials(
    credential_id, user_id, device_id, rp_id, public_key_spki, algorithm,
    sign_count, transports, created_at, revoked_at
  ) values (
    p_credential_id, p_user_id, p_device_id, p_rp_id, p_public_key_spki, p_algorithm,
    greatest(coalesce(p_sign_count,0),0), coalesce(p_transports,'{}'::text[]), now(), null
  )
  on conflict (credential_id) do update set
    user_id = excluded.user_id,
    device_id = excluded.device_id,
    rp_id = excluded.rp_id,
    public_key_spki = excluded.public_key_spki,
    algorithm = excluded.algorithm,
    sign_count = excluded.sign_count,
    transports = excluded.transports,
    revoked_at = null;

  insert into public.webauthn_device_vaults(user_id, device_id, version, iv, ciphertext, created_at, updated_at)
  values (p_user_id, p_device_id, p_vault_version, p_vault_iv, p_vault_ciphertext, now(), now())
  on conflict (user_id, device_id) do update set
    version = excluded.version,
    iv = excluded.iv,
    ciphertext = excluded.ciphertext,
    updated_at = now();

  update public.webauthn_device_challenges set consumed_at = now() where id = p_challenge_id;
  return jsonb_build_object('ok', true, 'code', 'WEBAUTHN_DEVICE_REGISTERED', 'device_id', p_device_id, 'credential_id', p_credential_id);
end;
$fn$;

create or replace function public.webauthn_finalize_device_recovery(
  p_user_id uuid,
  p_challenge_id uuid,
  p_credential_id text,
  p_new_sign_count bigint
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog, pg_temp
as $fn$
declare
  v_challenge public.webauthn_device_challenges%rowtype;
  v_credential public.webauthn_device_credentials%rowtype;
  v_device public.user_devices%rowtype;
  v_vault public.webauthn_device_vaults%rowtype;
begin
  select * into v_challenge from public.webauthn_device_challenges where id = p_challenge_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CHALLENGE_NOT_FOUND'); end if;
  if v_challenge.user_id <> p_user_id or v_challenge.purpose <> 'recover' then
    return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CHALLENGE_MISMATCH');
  end if;
  if v_challenge.consumed_at is not null then return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CHALLENGE_USED'); end if;
  if v_challenge.expires_at <= now() then return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CHALLENGE_EXPIRED'); end if;

  select * into v_credential
  from public.webauthn_device_credentials
  where credential_id = p_credential_id and user_id = p_user_id and rp_id = v_challenge.rp_id
  for update;
  if not found or v_credential.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_CREDENTIAL_NOT_FOUND');
  end if;

  if v_credential.sign_count > 0 and coalesce(p_new_sign_count,0) > 0 and p_new_sign_count <= v_credential.sign_count then
    return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_SIGN_COUNT_REPLAY');
  end if;

  select * into v_device
  from public.user_devices d
  where d.user_id = p_user_id and d.device_id = v_credential.device_id
  for update;
  if not found or v_device.approval_status <> 'approved' or v_device.binding_status <> 'bound'
     or v_device.lifecycle_status <> 'ready' or v_device.routing_status <> 'ready'
     or v_device.is_active <> true or v_device.revoked_at is not null then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_READY');
  end if;

  select * into v_vault from public.webauthn_device_vaults
  where user_id = p_user_id and device_id = v_credential.device_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'WEBAUTHN_DEVICE_VAULT_NOT_FOUND'); end if;

  update public.webauthn_device_credentials
  set sign_count = greatest(sign_count, coalesce(p_new_sign_count,0)), last_used_at = now()
  where credential_id = p_credential_id;
  update public.webauthn_device_challenges set consumed_at = now() where id = p_challenge_id;

  return jsonb_build_object(
    'ok', true,
    'code', 'WEBAUTHN_DEVICE_RECOVERED',
    'device_id', v_credential.device_id,
    'vault', jsonb_build_object('version', v_vault.version, 'iv', v_vault.iv, 'ciphertext', v_vault.ciphertext)
  );
end;
$fn$;

revoke all on function public.webauthn_finalize_device_registration(uuid,text,uuid,text,text,text,integer,bigint,text[],integer,text,text) from public, anon, authenticated;
revoke all on function public.webauthn_finalize_device_recovery(uuid,uuid,text,bigint) from public, anon, authenticated;
grant execute on function public.webauthn_finalize_device_registration(uuid,text,uuid,text,text,text,integer,bigint,text[],integer,text,text) to service_role;
grant execute on function public.webauthn_finalize_device_recovery(uuid,uuid,text,bigint) to service_role;
