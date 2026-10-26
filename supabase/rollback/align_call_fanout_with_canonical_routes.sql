begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Retour arriere structurel uniquement. Aucune ligne, invitation ou cle n'est
-- modifiee. Ce rollback restaure la definition precedente du RPC.
do $rollback$
declare
  definition text := pg_get_functiondef(
    'public.aegis_call_create(uuid,uuid,text,text,uuid[],jsonb)'::regprocedure
  );
  old_caller text := $old$
    select 1 from public.user_devices device
    where device.user_id = v_uid
      and device.device_id = p_caller_device_id
      and device.is_active = true
      and device.revoked_at is null
      and coalesce(device.approval_status, 'approved') = 'approved'
      and coalesce(device.routing_status, 'repairing') <> 'unavailable'
      and nullif(trim(device.device_authorization_signature), '') is not null
  $old$;
  new_caller text := $new$
    select 1 from public.get_sesame_device_list(v_uid) route
    where route.device_id = p_caller_device_id
      and route.is_routable = true
  $new$;
  old_expected text := $old$
    select device.user_id, device.device_id
    from public.user_devices device
    where device.user_id = any(v_invitees)
      and device.is_active = true
      and device.revoked_at is null
      and coalesce(device.approval_status, 'approved') = 'approved'
      and coalesce(device.routing_status, 'repairing') <> 'unavailable'
      and nullif(trim(device.device_public_key), '') is not null
      and nullif(trim(device.device_authorization_signature), '') is not null
  $old$;
  new_expected text := $new$
    select invitee.user_id, route.device_id
    from unnest(v_invitees) as invitee(user_id)
    cross join lateral public.get_sesame_device_list(invitee.user_id) route
    where route.is_routable = true
  $new$;
  old_expected_nested text;
  new_expected_nested text;
begin
  definition := replace(definition, E'\r\n', E'\n');
  if definition not like '%public.get_sesame_device_list(v_uid)%'
    or definition not like '%cross join lateral public.get_sesame_device_list(invitee.user_id)%' then
    raise exception 'AEGIS_CALL_CREATE_ROLLBACK_DEFINITION_UNEXPECTED';
  end if;
  definition := replace(definition, new_caller, old_caller);
  old_expected_nested := replace(old_expected, E'\n    ', E'\n      ');
  new_expected_nested := replace(new_expected, E'\n    ', E'\n      ');
  definition := replace(definition, new_expected, old_expected);
  definition := replace(definition, new_expected_nested, old_expected_nested);
  if definition like '%public.get_sesame_device_list(v_uid)%'
    or definition like '%cross join lateral public.get_sesame_device_list(invitee.user_id)%' then
    raise exception 'AEGIS_CALL_CREATE_ROLLBACK_REPLACEMENT_FAILED';
  end if;
  execute definition;
end
$rollback$;

notify pgrst, 'reload schema';
commit;
