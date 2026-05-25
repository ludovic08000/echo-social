-- Signed Device List foundation.
--
-- WhatsApp-style multi-device systems maintain a verifiable list of linked
-- devices. This migration adds the database primitive without breaking current
-- clients: current RPCs continue to work, but can now prefer devices present in
-- an active signed list when clients start publishing one.

create table if not exists public.signed_device_lists (
  user_id uuid primary key,
  device_ids text[] not null default '{}',
  list_version bigint not null default 1,
  signer_device_id text,
  signature text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.signed_device_lists enable row level security;

drop policy if exists "signed_device_lists_read_authenticated" on public.signed_device_lists;
create policy "signed_device_lists_read_authenticated"
on public.signed_device_lists
for select
to authenticated
using (true);

drop policy if exists "signed_device_lists_write_own" on public.signed_device_lists;
create policy "signed_device_lists_write_own"
on public.signed_device_lists
for all
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

create or replace function public.upsert_signed_device_list(
  p_device_ids text[],
  p_signer_device_id text default null,
  p_signature text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_clean text[];
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  select coalesce(array_agg(distinct d), '{}')
  into v_clean
  from unnest(coalesce(p_device_ids, '{}')) d
  where d is not null and length(trim(d)) >= 8;

  insert into public.signed_device_lists(user_id, device_ids, list_version, signer_device_id, signature, updated_at)
  values (v_user, v_clean, 1, p_signer_device_id, p_signature, now())
  on conflict (user_id) do update
  set device_ids = excluded.device_ids,
      list_version = public.signed_device_lists.list_version + 1,
      signer_device_id = excluded.signer_device_id,
      signature = excluded.signature,
      updated_at = now();

  return jsonb_build_object('ok', true, 'device_count', coalesce(array_length(v_clean, 1), 0));
end;
$$;

grant execute on function public.upsert_signed_device_list(text[], text, text) to authenticated;

-- Active device listing with invalid-device quarantine and optional signed-list
-- narrowing. If no signed list exists yet, behavior remains backward-compatible.
create or replace function public.list_active_devices_for_user(p_user_id uuid)
returns table (
  device_id text,
  device_public_key text,
  platform text,
  last_seen_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with sdl as (
    select device_ids
    from public.signed_device_lists
    where user_id = p_user_id
  )
  select
    ud.device_id,
    ud.device_public_key,
    ud.platform,
    ud.last_seen_at
  from public.user_devices ud
  where ud.user_id = p_user_id
    and ud.is_active = true
    and ud.device_public_key is not null
    and not exists (
      select 1 from public.invalid_e2ee_devices bad
      where bad.user_id = ud.user_id and bad.device_id = ud.device_id
    )
    and (
      not exists (select 1 from sdl)
      or ud.device_id = any((select device_ids from sdl))
    )
  order by ud.last_seen_at desc nulls last;
$$;

grant execute on function public.list_active_devices_for_user(uuid) to authenticated;
