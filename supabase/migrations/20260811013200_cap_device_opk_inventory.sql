-- Prevent concurrent tabs/runtimes from overfilling one device OPK inventory.
-- The device-scoped advisory lock already serialized publishes; this version
-- also recounts under that lock and accepts only the remaining capacity up to 100.

CREATE OR REPLACE FUNCTION public.publish_device_one_time_prekeys(
  p_device_id text,
  p_prekeys jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_device_id text := trim(coalesce(p_device_id, ''));
  v_count integer;
  v_distinct integer;
  v_conflicts integer;
  v_existing integer;
  v_capacity integer;
  v_accepted integer[];
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_AUTHENTICATED');
  end if;
  if jsonb_typeof(p_prekeys) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ONE_TIME_PREKEY_BATCH');
  end if;

  select count(*), count(distinct item.opk_id)
    into v_count, v_distinct
  from jsonb_to_recordset(p_prekeys) as item(opk_id integer, public_key text);
  if v_count < 1 or v_count > 100 or v_count <> v_distinct then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ONE_TIME_PREKEY_BATCH');
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_prekeys) as item(opk_id integer, public_key text)
    where item.opk_id <= 0
       or length(trim(coalesce(item.public_key, ''))) < 40
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ONE_TIME_PREKEY');
  end if;
  if not exists (
    select 1 from public.user_devices device
    where device.user_id = v_uid
      and device.device_id = v_device_id
      and device.is_active = true
      and device.revoked_at is null
      and coalesce(device.approval_status, 'approved') = 'approved'
      and device.routing_status = 'ready'
      and nullif(trim(device.device_authorization_signature), '') is not null
  ) then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_NOT_AUTHORIZED');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || v_device_id, 1));

  select count(*) into v_existing
  from public.device_one_time_prekeys existing
  where existing.user_id = v_uid
    and existing.device_id = v_device_id;
  v_capacity := greatest(0, 100 - v_existing);

  select count(*) into v_conflicts
  from jsonb_to_recordset(p_prekeys) as item(opk_id integer, public_key text)
  join public.device_one_time_prekeys existing
    on existing.user_id = v_uid
   and existing.device_id = v_device_id
   and existing.opk_id = item.opk_id
  where existing.public_key is distinct from item.public_key;
  if v_conflicts > 0 then
    return jsonb_build_object('ok', false, 'code', 'OPK_ID_CONFLICT');
  end if;

  with incoming as (
    select item.opk_id, item.public_key
    from jsonb_to_recordset(p_prekeys) as item(opk_id integer, public_key text)
  ), same_existing as (
    select incoming.opk_id
    from incoming
    join public.device_one_time_prekeys existing
      on existing.user_id = v_uid
     and existing.device_id = v_device_id
     and existing.opk_id = incoming.opk_id
     and existing.public_key = incoming.public_key
  ), candidates as (
    select incoming.opk_id, incoming.public_key
    from incoming
    left join public.device_one_time_prekeys existing
      on existing.user_id = v_uid
     and existing.device_id = v_device_id
     and existing.opk_id = incoming.opk_id
    where existing.id is null
    order by incoming.opk_id
    limit v_capacity
  ), inserted as (
    insert into public.device_one_time_prekeys (user_id, device_id, opk_id, public_key)
    select v_uid, v_device_id, candidates.opk_id, candidates.public_key
    from candidates
    on conflict (user_id, device_id, opk_id) do nothing
    returning opk_id
  ), accepted as (
    select opk_id from same_existing
    union
    select opk_id from inserted
  )
  select array_agg(opk_id order by opk_id)
    into v_accepted
  from accepted;

  select count(*) into v_existing
  from public.device_one_time_prekeys existing
  where existing.user_id = v_uid
    and existing.device_id = v_device_id;

  return jsonb_build_object(
    'ok', true,
    'code', 'ONE_TIME_PREKEYS_PUBLISHED',
    'accepted_ids', to_jsonb(coalesce(v_accepted, array[]::integer[])),
    'inventory_count', v_existing
  );
end;
$function$;
