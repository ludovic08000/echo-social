-- Read-only inventory used client-side to prove that the opaque encrypted
-- recovery snapshot contains the private half of every currently published
-- X3DH prekey. Private material never enters this function or the database.

begin;

create or replace function public.get_current_device_prekey_inventory(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_temp
stable
as $$
declare
  v_uid uuid:=auth.uid();
  v_spk jsonb;
  v_opks jsonb;
begin
  if v_uid is null then return jsonb_build_object('ok',false,'code','NOT_AUTHENTICATED'); end if;
  if not exists (
    select 1 from public.user_devices d
    where d.user_id=v_uid and d.device_id=p_device_id
      and d.is_active=true and d.revoked_at is null
      and d.approval_status='approved' and d.binding_status='bound'
  ) then
    return jsonb_build_object('ok',false,'code','DEVICE_NOT_BOUND');
  end if;

  select jsonb_build_object('spk_id',s.spk_id,'public_key',s.public_key)
    into v_spk
  from public.device_signed_prekeys s
  where s.user_id=v_uid and s.device_id=p_device_id and s.is_active=true
    and s.expires_at>now()
  order by s.created_at desc
  limit 1;

  select coalesce(jsonb_agg(
    jsonb_build_object('opk_id',o.opk_id,'public_key',o.public_key)
    order by o.opk_id
  ),'[]'::jsonb)
  into v_opks
  from public.device_one_time_prekeys o
  where o.user_id=v_uid and o.device_id=p_device_id;

  return jsonb_build_object('ok',v_spk is not null,'spk',v_spk,'opks',v_opks);
end;
$$;

revoke all on function public.get_current_device_prekey_inventory(text) from public,anon;
grant execute on function public.get_current_device_prekey_inventory(text) to authenticated;

commit;
