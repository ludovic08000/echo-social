begin;

-- Harden the already-deployed PIN continuity vault. The browser may use only
-- the four authenticated RPCs; direct table access remains closed even when a
-- future client bypasses the intended SDK wrapper.
alter table public.aegis_pin_continuity_vault enable row level security;

revoke all on table public.aegis_pin_continuity_vault
from public, anon, authenticated;
grant all on table public.aegis_pin_continuity_vault to service_role;

drop policy if exists "Owner reads own pin continuity vault"
  on public.aegis_pin_continuity_vault;
drop policy if exists "Owner writes own pin continuity vault"
  on public.aegis_pin_continuity_vault;
drop policy if exists "Owner updates own pin continuity vault"
  on public.aegis_pin_continuity_vault;
drop policy if exists "Owner deletes own pin continuity vault"
  on public.aegis_pin_continuity_vault;

create or replace function public.aegis_pin_continuity_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  new.updated_at := now();
  new.user_id := old.user_id;
  return new;
end;
$function$;

create or replace function public.aegis_pin_continuity_has()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'AEGIS_PIN_CONTINUITY_UNAUTHENTICATED'
      using errcode = '42501';
  end if;

  return exists (
    select 1
    from public.aegis_pin_continuity_vault vault
    where vault.user_id = v_uid
  );
end;
$function$;

create or replace function public.aegis_pin_continuity_get()
returns table (
  version integer,
  ciphertext text,
  iv text,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'AEGIS_PIN_CONTINUITY_UNAUTHENTICATED'
      using errcode = '42501';
  end if;

  return query
  select vault.version, vault.ciphertext, vault.iv, vault.updated_at
  from public.aegis_pin_continuity_vault vault
  where vault.user_id = v_uid;
end;
$function$;

create or replace function public.aegis_pin_continuity_upsert(
  p_version integer,
  p_ciphertext text,
  p_iv text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_ciphertext_bytes integer;
  v_iv_bytes integer;
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
    iv
  ) values (
    v_uid,
    p_version,
    p_ciphertext,
    p_iv
  )
  on conflict (user_id) do update
  set version = excluded.version,
      ciphertext = excluded.ciphertext,
      iv = excluded.iv;

  return true;
end;
$function$;

create or replace function public.aegis_pin_continuity_delete()
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'AEGIS_PIN_CONTINUITY_UNAUTHENTICATED'
      using errcode = '42501';
  end if;

  delete from public.aegis_pin_continuity_vault
  where user_id = v_uid;
  return true;
end;
$function$;

revoke all on function public.aegis_pin_continuity_touch()
from public, anon, authenticated;
revoke all on function public.aegis_pin_continuity_has()
from public, anon, authenticated;
revoke all on function public.aegis_pin_continuity_get()
from public, anon, authenticated;
revoke all on function public.aegis_pin_continuity_upsert(integer, text, text)
from public, anon, authenticated;
revoke all on function public.aegis_pin_continuity_delete()
from public, anon, authenticated;

grant execute on function public.aegis_pin_continuity_has()
to authenticated, service_role;
grant execute on function public.aegis_pin_continuity_get()
to authenticated, service_role;
grant execute on function public.aegis_pin_continuity_upsert(integer, text, text)
to authenticated, service_role;
grant execute on function public.aegis_pin_continuity_delete()
to authenticated, service_role;

do $verification$
begin
  if has_table_privilege('authenticated', 'public.aegis_pin_continuity_vault', 'select')
     or has_table_privilege('authenticated', 'public.aegis_pin_continuity_vault', 'insert')
     or has_table_privilege('authenticated', 'public.aegis_pin_continuity_vault', 'update')
     or has_table_privilege('authenticated', 'public.aegis_pin_continuity_vault', 'delete') then
    raise exception 'AEGIS_PIN_CONTINUITY_DIRECT_AUTHENTICATED_ACCESS';
  end if;
  if has_table_privilege('anon', 'public.aegis_pin_continuity_vault', 'select')
     or has_table_privilege('anon', 'public.aegis_pin_continuity_vault', 'insert')
     or has_table_privilege('anon', 'public.aegis_pin_continuity_vault', 'update')
     or has_table_privilege('anon', 'public.aegis_pin_continuity_vault', 'delete') then
    raise exception 'AEGIS_PIN_CONTINUITY_DIRECT_ANON_ACCESS';
  end if;
  if not has_function_privilege(
    'authenticated',
    'public.aegis_pin_continuity_has()',
    'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.aegis_pin_continuity_get()',
    'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.aegis_pin_continuity_upsert(integer,text,text)',
    'execute'
  ) or not has_function_privilege(
    'authenticated',
    'public.aegis_pin_continuity_delete()',
    'execute'
  ) then
    raise exception 'AEGIS_PIN_CONTINUITY_RPC_GRANTS_MISSING';
  end if;
end;
$verification$;

notify pgrst, 'reload schema';

commit;
