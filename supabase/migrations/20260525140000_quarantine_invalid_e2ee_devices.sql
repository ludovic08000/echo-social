-- Hard quarantine invalid E2EE devices at database/RPC level.
--
-- Problem observed in production:
-- Several device ids are still returned as active although their device SPK
-- signature does not verify against the active account signing key. Per X3DH,
-- senders must abort when Signed PreKey verification fails. The database must
-- stop advertising these devices as valid targets.

create table if not exists public.invalid_e2ee_devices (
  user_id uuid not null,
  device_id text not null,
  reason text not null default 'invalid_device_spk_signature',
  created_at timestamptz not null default now(),
  primary key (user_id, device_id)
);

alter table public.invalid_e2ee_devices enable row level security;

drop policy if exists "invalid_e2ee_devices_read_own" on public.invalid_e2ee_devices;
create policy "invalid_e2ee_devices_read_own"
on public.invalid_e2ee_devices
for select
to authenticated
using (user_id = auth.uid());

-- Seed known bad routing ids observed in logs.
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

-- Immediately deactivate quarantined devices and their active SPKs.
update public.user_devices ud
set is_active = false
where exists (
  select 1
  from public.invalid_e2ee_devices bad
  where bad.user_id = ud.user_id
    and bad.device_id = ud.device_id
);

update public.device_signed_prekeys dsp
set is_active = false,
    is_last_resort = false
where exists (
  select 1
  from public.invalid_e2ee_devices bad
  where bad.user_id = dsp.user_id
    and bad.device_id = dsp.device_id
);

-- Sender-side device listing. Never advertise quarantined devices as targets.
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
      select 1
      from public.invalid_e2ee_devices bad
      where bad.user_id = ud.user_id
        and bad.device_id = ud.device_id
    )
  order by ud.last_seen_at desc nulls last;
$$;

grant execute on function public.list_active_devices_for_user(uuid) to authenticated;

-- X3DH bundle resolver. Never return a SPK for a quarantined device.
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
  select
    dsp.spk_id,
    dsp.public_key,
    dsp.signature
  from public.device_signed_prekeys dsp
  join public.user_devices ud
    on ud.user_id = dsp.user_id
   and ud.device_id = dsp.device_id
  where dsp.user_id = p_user_id
    and dsp.device_id = p_device_id
    and dsp.is_active = true
    and ud.is_active = true
    and not exists (
      select 1
      from public.invalid_e2ee_devices bad
      where bad.user_id = dsp.user_id
        and bad.device_id = dsp.device_id
    )
  order by dsp.created_at desc nulls last, dsp.spk_id desc
  limit 1;
$$;

grant execute on function public.get_device_prekey_bundle(uuid, text) to authenticated;

-- Client-side repair hook: current authenticated user can quarantine one of
-- their own devices after local cryptographic verification fails.
create or replace function public.quarantine_own_invalid_device(
  p_device_id text,
  p_reason text default 'invalid_device_spk_signature'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;

  if p_device_id is null or length(trim(p_device_id)) < 8 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DEVICE_ID');
  end if;

  insert into public.invalid_e2ee_devices (user_id, device_id, reason)
  values (v_user, p_device_id, left(coalesce(p_reason, 'invalid_device_spk_signature'), 200))
  on conflict (user_id, device_id) do update
  set reason = excluded.reason;

  update public.user_devices
  set is_active = false
  where user_id = v_user
    and device_id = p_device_id;

  update public.device_signed_prekeys
  set is_active = false,
      is_last_resort = false
  where user_id = v_user
    and device_id = p_device_id;

  return jsonb_build_object('ok', true, 'code', 'DEVICE_QUARANTINED', 'device_id', p_device_id);
end;
$$;

grant execute on function public.quarantine_own_invalid_device(text, text) to authenticated;
