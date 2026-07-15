begin;

create or replace function public.get_signed_device_list(
  p_user_id uuid
)
returns table (
  device_id text,
  device_public_key text,
  is_primary boolean,
  primary_device_id text,
  primary_pub_b64 text,
  signature_b64 text,
  signed_at timestamptz
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  with approved_devices as (
    select
      ud.device_id,
      ud.device_public_key,
      ud.is_primary
    from public.user_devices ud
    where ud.user_id = p_user_id
      and ud.is_active = true
      and ud.approval_status = 'approved'
      and ud.revoked_at is null
  ),
  primary_device as (
    select ad.device_id
    from approved_devices ad
    where ad.is_primary = true
    order by ad.device_id
    limit 1
  ),
  active_signatures as (
    select distinct on (uds.device_id)
      uds.device_id,
      uds.primary_device_id,
      uds.primary_pub_b64,
      uds.signature_b64,
      uds.signed_at
    from public.user_device_signatures uds
    join primary_device pd
      on pd.device_id = uds.primary_device_id
    where uds.user_id = p_user_id
      and uds.revoked_at is null
      and uds.primary_pub_b64 is not null
      and uds.signature_b64 is not null
    order by uds.device_id, uds.signed_at desc
  ),
  coherent_primary_root as (
    select min(sig.primary_pub_b64) as primary_pub_b64
    from active_signatures sig
    having count(distinct sig.primary_pub_b64) = 1
  )
  select
    ad.device_id,
    ad.device_public_key,
    ad.is_primary,
    case when ad.is_primary then null else sig.primary_device_id end,
    case when ad.is_primary then root.primary_pub_b64 else sig.primary_pub_b64 end,
    case when ad.is_primary then null else sig.signature_b64 end,
    case when ad.is_primary then null else sig.signed_at end
  from approved_devices ad
  left join active_signatures sig on sig.device_id = ad.device_id
  left join coherent_primary_root root on true
  order by ad.is_primary desc, ad.device_id;
$$;

revoke all on function public.get_signed_device_list(uuid) from public;
grant execute on function public.get_signed_device_list(uuid) to authenticated;

commit;
