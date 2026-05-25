-- Hard cleanup for invalid E2EE devices still appearing in production logs.
-- This migration is intentionally aggressive: invalid devices must not be listed,
-- must not expose SPKs, and must not keep OPKs.

create table if not exists public.invalid_e2ee_devices (
  user_id uuid not null,
  device_id text not null,
  reason text not null default 'invalid_e2ee_device',
  created_at timestamptz not null default now(),
  primary key (user_id, device_id)
);

insert into public.invalid_e2ee_devices (user_id, device_id, reason)
values
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '84aaa52143235807214bf3aa161dd03a', 'revoked_device_reactivation_blocked'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '6508eb47a200893f49720fe84b9290b3', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '9da8c742a4fe81d1d9ce6c0ffb4e055b', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '75e575fcbfaa8066bcbc9105fc5f4ac8', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, 'c6601674b0f700f28c9f2956774eca97', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '52adb13ff236ae5c833c9d9049c0df71', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, 'b166de502d729356dcbd6c0b5b1a39b0', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '49cfdeab59355de3051925b4f09fba75', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '92585130870cedf210af1019379dbc61', 'invalid_device_spk_signature'),
  ('ffeb378a-e1b3-4bfb-8c31-72c94e4da14d'::uuid, '450c0cd9af35813c8a99ec5bc0f39ab8', 'invalid_device_spk_signature')
on conflict (user_id, device_id) do update
set reason = excluded.reason;

-- Do not leave stale public key material for devices that every client rejects.
delete from public.device_one_time_prekeys opk
where exists (
  select 1 from public.invalid_e2ee_devices bad
  where bad.user_id = opk.user_id and bad.device_id = opk.device_id
);

update public.device_signed_prekeys spk
set is_active = false,
    is_last_resort = false
where exists (
  select 1 from public.invalid_e2ee_devices bad
  where bad.user_id = spk.user_id and bad.device_id = spk.device_id
);

update public.user_devices ud
set is_active = false
where exists (
  select 1 from public.invalid_e2ee_devices bad
  where bad.user_id = ud.user_id and bad.device_id = ud.device_id
);

-- Fingerprint recovery must never return an invalid/revoked device id.
create or replace function public.resolve_device_id_by_fingerprints(
  p_fingerprints text[],
  p_platform text default null
)
returns text
language sql
security definer
set search_path = public
as $$
  select ud.device_id
  from public.user_devices ud
  where ud.user_id = auth.uid()
    and ud.is_active = true
    and ud.device_fingerprint = any(coalesce(p_fingerprints, '{}'))
    and (p_platform is null or ud.platform = p_platform)
    and not exists (
      select 1 from public.invalid_e2ee_devices bad
      where bad.user_id = ud.user_id and bad.device_id = ud.device_id
    )
  order by ud.last_seen_at desc nulls last
  limit 1;
$$;

grant execute on function public.resolve_device_id_by_fingerprints(text[], text) to authenticated;

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
  select ud.device_id, ud.device_public_key, ud.platform, ud.last_seen_at
  from public.user_devices ud
  where ud.user_id = p_user_id
    and ud.is_active = true
    and ud.device_public_key is not null
    and not exists (
      select 1 from public.invalid_e2ee_devices bad
      where bad.user_id = ud.user_id and bad.device_id = ud.device_id
    )
  order by ud.last_seen_at desc nulls last;
$$;

grant execute on function public.list_active_devices_for_user(uuid) to authenticated;

create or replace function public.get_device_prekey_bundle(
  p_user_id uuid,
  p_device_id text
)
returns table (
  spk_id integer,
  public_key text,
  signature text
)
language sql
security definer
set search_path = public
as $$
  select spk.spk_id, spk.public_key, spk.signature
  from public.device_signed_prekeys spk
  join public.user_devices ud
    on ud.user_id = spk.user_id and ud.device_id = spk.device_id
  where spk.user_id = p_user_id
    and spk.device_id = p_device_id
    and spk.is_active = true
    and ud.is_active = true
    and not exists (
      select 1 from public.invalid_e2ee_devices bad
      where bad.user_id = spk.user_id and bad.device_id = spk.device_id
    )
  order by spk.created_at desc nulls last, spk.spk_id desc
  limit 1;
$$;

grant execute on function public.get_device_prekey_bundle(uuid, text) to authenticated;
