begin;

create table if not exists public.aegis_recovery_vaults (
  user_id uuid primary key references auth.users(id) on delete cascade,
  protocol_version smallint not null check (protocol_version = 1),
  generation bigint not null check (generation > 0),
  identity_fingerprint text not null check (length(identity_fingerprint) between 16 and 256),
  kdf_salt text not null check (length(kdf_salt) between 32 and 256),
  nonce text not null check (length(nonce) between 12 and 128),
  ciphertext text not null check (length(ciphertext) between 64 and 1048576),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.aegis_recovery_vaults enable row level security;

revoke all on table public.aegis_recovery_vaults from anon, authenticated;
grant select on table public.aegis_recovery_vaults to authenticated;

drop policy if exists aegis_recovery_vault_select_own on public.aegis_recovery_vaults;
create policy aegis_recovery_vault_select_own
  on public.aegis_recovery_vaults
  for select
  to authenticated
  using (user_id = auth.uid());

create or replace function public.write_aegis_recovery_vault(
  p_protocol_version smallint,
  p_generation bigint,
  p_identity_fingerprint text,
  p_kdf_salt text,
  p_nonce text,
  p_ciphertext text
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_current_generation bigint;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '42501';
  end if;
  if p_protocol_version <> 1 then
    raise exception 'UNSUPPORTED_RECOVERY_VERSION' using errcode = '22023';
  end if;
  if p_generation < 1 then
    raise exception 'INVALID_RECOVERY_GENERATION' using errcode = '22023';
  end if;
  if length(p_identity_fingerprint) not between 16 and 256
    or length(p_kdf_salt) not between 32 and 256
    or length(p_nonce) not between 12 and 128
    or length(p_ciphertext) not between 64 and 1048576 then
    raise exception 'INVALID_RECOVERY_VAULT_PAYLOAD' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':aegis-recovery-v1', 0));

  select generation
    into v_current_generation
    from public.aegis_recovery_vaults
   where user_id = v_user_id
   for update;

  if v_current_generation is null then
    if p_generation <> 1 then
      raise exception 'STALE_RECOVERY_GENERATION' using errcode = '40001';
    end if;
  elsif p_generation <> v_current_generation + 1 then
    raise exception 'STALE_RECOVERY_GENERATION' using errcode = '40001';
  end if;

  insert into public.aegis_recovery_vaults (
    user_id,
    protocol_version,
    generation,
    identity_fingerprint,
    kdf_salt,
    nonce,
    ciphertext,
    created_at,
    updated_at
  ) values (
    v_user_id,
    p_protocol_version,
    p_generation,
    p_identity_fingerprint,
    p_kdf_salt,
    p_nonce,
    p_ciphertext,
    now(),
    now()
  )
  on conflict (user_id) do update set
    protocol_version = excluded.protocol_version,
    generation = excluded.generation,
    identity_fingerprint = excluded.identity_fingerprint,
    kdf_salt = excluded.kdf_salt,
    nonce = excluded.nonce,
    ciphertext = excluded.ciphertext,
    updated_at = now();

  return p_generation;
end;
$$;

revoke all on function public.write_aegis_recovery_vault(smallint, bigint, text, text, text, text) from public, anon;
grant execute on function public.write_aegis_recovery_vault(smallint, bigint, text, text, text, text) to authenticated;

commit;
